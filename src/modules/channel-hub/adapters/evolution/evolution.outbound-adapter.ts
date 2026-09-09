import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { EvolutionMessageMapper } from './evolution.message-mapper';
import { EvolutionHttpClient } from './evolution.http-client';

@Injectable()
export class EvolutionOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_EVOLUTION;
  private readonly logger = new Logger(EvolutionOutboundAdapter.name);

  constructor(
    private readonly mapper: EvolutionMessageMapper,
    private readonly httpClient: EvolutionHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const { endpoint, body } = this.mapper.denormalize(
      this.httpClient.cfg(channel),
      message,
      contactExternalId,
    );
    const res = await this.httpClient.post(channel, endpoint, body);
    return {
      externalId: res?.key?.id || res?.messageId || res?.id || '',
      providerResponse: res,
    };
  }

  async sendTypingIndicator(): Promise<void> {
    return;
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.downloadMedia(channel, mediaId);
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 1, maxPerMinute: 30, windowMs: 60000 };
  }
}
