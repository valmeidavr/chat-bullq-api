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
import { TwilioMenuContentService } from './twilio-menu-content.service';

@Injectable()
export class TwilioOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_TWILIO;
  private readonly logger = new Logger(TwilioOutboundAdapter.name);

  constructor(
    private readonly mapper: TwilioMessageMapper,
    private readonly httpClient: TwilioHttpClient,
    private readonly menuContent: TwilioMenuContentService,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    // Menu nativo (nó MENU): resolve/reusa um Content template (quick-reply ou
    // list-picker) e envia via ContentSid. Se falhar, cai no texto (fallback).
    const menu = message.content.interactiveMenu;
    if (menu && menu.options?.length && menu.options.length <= 10 && !message.content.contentSid) {
      try {
        const cfg = this.httpClient.cfg(channel);
        const { contentSid } = await this.menuContent.ensure(channel.id, {
          accountSid: cfg.accountSid,
          authToken: cfg.authToken,
        }, menu);
        message.content.contentSid = contentSid;
      } catch (err: any) {
        this.logger.warn(
          `Menu nativo falhou (canal ${channel.id}); usando texto. ${err?.message ?? err}`,
        );
      }
    }

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
