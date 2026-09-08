import { Injectable, Logger } from '@nestjs/common';
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
    _headers: Record<string, string>,
    rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    // v1: confere que o AccountSid do corpo bate com o do canal. (Validação
    // completa da assinatura X-Twilio-Signature é hardening de fase seguinte.)
    try {
      const params = new URLSearchParams(rawBody?.toString() || '');
      const accountSid = params.get('AccountSid');
      const config = (channel?.config ?? {}) as Record<string, any>;
      if (!accountSid || !config.accountSid) return true; // não bloqueia se faltou dado
      return String(accountSid) === String(config.accountSid);
    } catch (err: any) {
      this.logger.warn(`validateWebhook falhou: ${err.message}`);
      return true;
    }
  }

  parseWebhook(payload: unknown): WebhookParseResult {
    return this.mapper.parseWebhook(payload);
  }
}
