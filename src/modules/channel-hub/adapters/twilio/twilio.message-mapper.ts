import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  MessageContentType,
  NormalizedOutboundMessage,
  WebhookParseResult,
  StatusUpdate,
  NormalizedInboundMessage,
} from '../../ports/types';
import { TwilioConfig } from './twilio.http-client';

/** whatsapp:+5511999998888 -> 5511999998888 ; +5511... -> 5511... */
function stripWa(v?: string): string {
  return (v ?? '').replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
}
function toWa(numberDigits: string): string {
  const digits = numberDigits.replace(/[^\d]/g, '');
  return `whatsapp:+${digits}`;
}

const STATUS_MAP: Record<string, StatusUpdate['status'] | undefined> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
  // queued/sending/accepted não geram update visível
};

function inboundType(mimeType?: string): MessageContentType {
  if (!mimeType) return MessageContentType.DOCUMENT;
  if (mimeType.startsWith('image/')) return MessageContentType.IMAGE;
  if (mimeType.startsWith('audio/')) return MessageContentType.AUDIO;
  if (mimeType.startsWith('video/')) return MessageContentType.VIDEO;
  return MessageContentType.DOCUMENT;
}

@Injectable()
export class TwilioMessageMapper {
  /** NormalizedOutboundMessage -> campos do endpoint Messages.json do Twilio. */
  denormalize(
    cfg: TwilioConfig,
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): Record<string, string> {
    const params: Record<string, string> = {
      To: toWa(stripWa(contactExternalId)),
    };

    if (cfg.messagingServiceSid) {
      params.MessagingServiceSid = cfg.messagingServiceSid;
    } else {
      params.From = toWa(stripWa(cfg.fromNumber));
    }

    const c = message.content;
    const text = c.text ?? c.caption;
    if (text) params.Body = text;
    if (c.mediaUrl) params.MediaUrl = c.mediaUrl;

    return params;
  }

  /** Body do webhook Twilio (form) -> mensagens/status normalizados. */
  parseWebhook(payload: unknown): WebhookParseResult {
    const b = (payload ?? {}) as Record<string, string>;
    const messages: NormalizedInboundMessage[] = [];
    const statuses: StatusUpdate[] = [];

    // Status callback: tem MessageStatus e não é mensagem de entrada.
    const rawStatus = (b.MessageStatus || b.SmsStatus || '').toLowerCase();
    if (rawStatus && !b.Body && !b.NumMedia) {
      const mapped = STATUS_MAP[rawStatus];
      if (mapped) {
        statuses.push({
          externalMessageId: b.MessageSid || b.SmsSid || '',
          status: mapped,
          timestamp: new Date(),
          errorMessage: b.ErrorCode ? `Twilio error ${b.ErrorCode}` : undefined,
        });
      }
      return { messages, statuses, errors: [] };
    }

    // Mensagem de entrada.
    const from = stripWa(b.From);
    if (!from) return { messages, statuses, errors: [] };

    const numMedia = parseInt(b.NumMedia || '0', 10) || 0;
    let type = MessageContentType.TEXT;
    const content: NormalizedInboundMessage['content'] = {};
    if (b.Body) content.text = b.Body;

    if (numMedia > 0) {
      const mediaUrl = b.MediaUrl0;
      const mimeType = b.MediaContentType0;
      type = inboundType(mimeType);
      content.mediaUrl = mediaUrl;
      content.mimeType = mimeType;
      if (b.Body) content.caption = b.Body;
    }

    messages.push({
      externalMessageId: b.MessageSid || b.SmsMessageSid || '',
      externalContactId: from,
      contactName: b.ProfileName || undefined,
      contactPhone: from,
      channelType: ChannelType.WHATSAPP_TWILIO,
      timestamp: new Date(),
      type,
      content,
      rawPayload: b,
    });

    return { messages, statuses, errors: [] };
  }
}
