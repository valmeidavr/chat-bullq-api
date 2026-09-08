import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { TwilioMessageMapper } from './twilio.message-mapper';
import { TwilioHttpClient } from './twilio.http-client';

@Injectable()
export class TwilioOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_TWILIO;
  private readonly logger = new Logger(TwilioOutboundAdapter.name);

  constructor(
    private readonly mapper: TwilioMessageMapper,
    private readonly httpClient: TwilioHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const params = this.mapper.denormalize(
      this.httpClient.cfg(channel),
      message,
      contactExternalId,
    );
    const response = await this.httpClient.sendMessage(channel, params);
    return {
      externalId: response?.sid || '',
      providerResponse: response,
    };
  }

  // Twilio WhatsApp não expõe indicador de digitação — no-op.
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
    return { maxPerSecond: 1, maxPerMinute: 60, windowMs: 60000 };
  }
}
