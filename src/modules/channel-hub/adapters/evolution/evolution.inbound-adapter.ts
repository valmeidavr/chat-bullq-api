import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';
import { EvolutionMessageMapper } from './evolution.message-mapper';

/**
 * Inbound da Evolution API. Roteia pela `instance` (e apikey quando presente).
 */
@Injectable()
export class EvolutionInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_EVOLUTION;
  private readonly logger = new Logger(EvolutionInboundAdapter.name);

  constructor(private readonly mapper: EvolutionMessageMapper) {}

  extractLocators(payload: unknown, headers: Record<string, string>): ChannelLocator[] {
    const evt = (payload ?? {}) as Record<string, any>;
    const locator: ChannelLocator = {};
    const instance = evt.instance || evt.instanceName || evt.data?.instance;
    const token = headers['apikey'] || evt.apikey || evt.token;
    if (instance) locator.instanceId = String(instance);
    if (token) locator.token = String(token);
    return [locator];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    if (locator.instanceId && config.instance) {
      return String(config.instance) === locator.instanceId;
    }
    if (locator.token && config.apiKey) {
      return String(config.apiKey) === locator.token;
    }
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    _rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    // Se a apikey vier no header, confere com a do canal; senão não bloqueia
    // (o roteamento por instance já garante o canal certo).
    const config = (channel?.config ?? {}) as Record<string, any>;
    const headerKey = headers['apikey'];
    if (headerKey && config.apiKey) return String(headerKey) === String(config.apiKey);
    return true;
  }

  parseWebhook(payload: unknown): WebhookParseResult {
    return this.mapper.parseWebhook(payload);
  }
}
