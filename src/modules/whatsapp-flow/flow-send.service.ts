import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TwilioHttpClient } from '../channel-hub/adapters/twilio/twilio.http-client';
import { TwilioContentClient } from '../templates/twilio-content.client';
import { WhatsAppFlowService } from './whatsapp-flow.service';

export interface FlowSendPlan {
  contentSid: string;
  flowToken: string;
}

/**
 * Prepara o envio de um WhatsApp Flow num canal. Só Twilio/Meta oficial com
 * `config.agendaFlowId` configurado; qualquer outro canal (Evolution, Zappfy…)
 * devolve `null` e o fluxo cai no caminho de lista paginada.
 *
 * O Content template (whatsapp/flows) é criado uma vez e reaproveitado via
 * cache no Redis, chaveado por canal + flowId + textos.
 */
@Injectable()
export class FlowSendService {
  private readonly logger = new Logger(FlowSendService.name);
  private readonly redis: Redis;
  private readonly content = new TwilioContentClient();
  private readonly TTL = 60 * 60 * 24 * 30;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioHttpClient,
    private readonly flow: WhatsAppFlowService,
  ) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
    });
  }

  /**
   * Devolve o plano de envio, ou `null` quando o canal não suporta Flow
   * (aí o chamador segue pelo fallback).
   */
  async prepare(
    channelId: string,
    conversationId: string,
    opts: { body: string; buttonText: string; firstScreen?: string },
  ): Promise<FlowSendPlan | null> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return null;

    const cfg = (channel.config ?? {}) as Record<string, any>;
    const flowId = cfg.agendaFlowId;
    if (!flowId) return null; // Flow não configurado neste canal → fallback.

    // Por enquanto só Twilio envia Flow por aqui (Meta oficial usa outro caminho).
    if (channel.type !== ChannelType.WHATSAPP_TWILIO) return null;

    const hash = createHash('sha1')
      .update(`${flowId}|${opts.body}|${opts.buttonText}|${opts.firstScreen ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    const key = `flow:content:${channelId}:${hash}`;

    let contentSid = await this.redis.get(key).catch(() => null);
    if (!contentSid) {
      try {
        const creds = { accountSid: cfg.accountSid, authToken: cfg.authToken };
        const created = await this.content.createFlowTemplate(creds, {
          name: `agenda_flow_${channelId.slice(0, 8)}_${hash}`,
          language: 'pt_BR',
          body: opts.body,
          buttonText: opts.buttonText,
          flowId: String(flowId),
          firstScreen: opts.firstScreen,
        });
        contentSid = created.sid;
        await this.redis.setex(key, this.TTL, contentSid).catch(() => undefined);
        this.logger.log(`Content de Flow criado: ${contentSid} (canal ${channelId})`);
      } catch (err: any) {
        this.logger.warn(
          `Falha ao criar Content de Flow (canal ${channelId}) — caindo no fallback: ${err?.response?.data?.message || err?.message}`,
        );
        return null;
      }
    }

    const flowToken = await this.flow.createToken(conversationId);
    return { contentSid, flowToken };
  }
}
