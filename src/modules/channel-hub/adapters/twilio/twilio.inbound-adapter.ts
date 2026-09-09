import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';
import { TwilioMessageMapper } from './twilio.message-mapper';

function digits(v?: string): string {
  return (v ?? '').replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
}

/**
 * Inbound do Twilio (WhatsApp). O Twilio faz POST form-urlencoded pra
 * `/webhooks/WHATSAPP_TWILIO` — tanto mensagens recebidas quanto status
 * callbacks. Roteia por AccountSid + número sender (To).
 */
@Injectable()
export class TwilioInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_TWILIO;
  private readonly logger = new Logger(TwilioInboundAdapter.name);

  constructor(private readonly mapper: TwilioMessageMapper) {}

  extractLocators(payload: unknown): ChannelLocator[] {
    const b = (payload ?? {}) as Record<string, string>;
    const locator: ChannelLocator = {};
    // O número do NOSSO canal é o "To" numa mensagem recebida (o cliente
    // manda PARA o sender). Em status callback o sender é o "From".
    const sender = digits(b.To) || digits(b.From);
    if (b.AccountSid) locator.token = b.AccountSid;
    if (sender) locator.phoneNumberId = sender;
    return [locator];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    // AccountSid tem que bater sempre que presente dos dois lados.
    if (locator.token && config.accountSid) {
      if (String(config.accountSid) !== String(locator.token)) return false;
    } else {
      return false;
    }
    // Se o canal define um número sender, ele precisa casar com o "To".
    if (config.fromNumber && locator.phoneNumberId) {
      return digits(config.fromNumber) === locator.phoneNumberId;
    }
    // Sem número configurado (ex.: Messaging Service): AccountSid basta.
    return true;
  }

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    try {
      const params = new URLSearchParams(rawBody?.toString() || '');
      const accountSid = params.get('AccountSid');
      const config = (channel?.config ?? {}) as Record<string, any>;

      // Camada 1: AccountSid do corpo bate com o do canal.
      if (accountSid && config.accountSid && String(accountSid) !== String(config.accountSid)) {
        this.logger.warn(`validateWebhook: AccountSid não confere (canal ${channel?.id})`);
        return false;
      }

      // Camada 2 (opt-in): assinatura X-Twilio-Signature (HMAC-SHA1 do
      // URL público + params ordenados, com o authToken). Só valida se
      // habilitada; em divergência, por padrão apenas LOGA (log-only) e só
      // REJEITA quando o enforce estiver ligado — evita derrubar inbound antes
      // de conferir contra o tráfego real.
      const wantSig =
        config.twilioValidateSignature === true ||
        process.env.TWILIO_VALIDATE_SIGNATURE === 'true';
      if (wantSig) {
        const h = this.lowerHeaders(headers);
        const url = config.publicWebhookUrl || process.env.TWILIO_PUBLIC_WEBHOOK_URL;
        const authToken = config.authToken;
        const sig = h['x-twilio-signature'];
        if (url && authToken && sig) {
          const sortedKeys = [...params.keys()].sort();
          let data = String(url);
          for (const k of sortedKeys) data += k + (params.get(k) ?? '');
          const expected = createHmac('sha1', String(authToken))
            .update(data, 'utf8')
            .digest('base64');
          if (!this.safeEqual(expected, String(sig))) {
            const enforce =
              config.twilioEnforceSignature === true ||
              process.env.TWILIO_ENFORCE_SIGNATURE === 'true';
            this.logger.warn(
              `X-Twilio-Signature ${enforce ? 'REJEITADA' : 'divergente (log-only)'} — canal ${channel?.id}`,
            );
            if (enforce) return false;
          }
        } else {
          this.logger.warn(
            `validateWebhook: assinatura habilitada mas falta url/authToken/header (canal ${channel?.id})`,
          );
        }
      }
      return true;
    } catch (err: any) {
      this.logger.warn(`validateWebhook falhou: ${err.message}`);
      return true;
    }
  }

  private lowerHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
    return out;
  }

  private safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  parseWebhook(payload: unknown): WebhookParseResult {
    return this.mapper.parseWebhook(payload);
  }
}
