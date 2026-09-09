import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  MessageContentType,
  NormalizedOutboundMessage,
  NormalizedInboundMessage,
  WebhookParseResult,
  StatusUpdate,
} from '../../ports/types';
import { EvolutionConfig } from './evolution.http-client';

function jidToNumber(jid?: string): string {
  return (jid ?? '').replace(/@s\.whatsapp\.net|@g\.us|@c\.us/g, '').replace(/[^\d]/g, '');
}

const STATUS_MAP: Record<string, StatusUpdate['status'] | undefined> = {
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  SERVER_ACK: 'sent',
  PLAYED: 'read',
};

@Injectable()
export class EvolutionMessageMapper {
  /** NormalizedOutboundMessage -> { endpoint, body } da Evolution. */
  denormalize(
    cfg: EvolutionConfig,
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): { endpoint: string; body: Record<string, any> } {
    const number = jidToNumber(contactExternalId);
    const c = message.content;

    if (c.mediaUrl && message.type !== MessageContentType.TEXT) {
      const mediatype =
        message.type === MessageContentType.IMAGE
          ? 'image'
          : message.type === MessageContentType.VIDEO
            ? 'video'
            : message.type === MessageContentType.AUDIO
              ? 'audio'
              : 'document';
      return {
        endpoint: `/message/sendMedia/${cfg.instance}`,
        body: {
          number,
          mediatype,
          media: c.mediaUrl,
          caption: c.caption || c.text || undefined,
          fileName: c.fileName || undefined,
        },
      };
    }

    return {
      endpoint: `/message/sendText/${cfg.instance}`,
      body: { number, text: c.text ?? c.caption ?? '' },
    };
  }

  /** Payload do webhook Evolution -> mensagens/status normalizados. */
  parseWebhook(payload: unknown): WebhookParseResult {
    const evt = (payload ?? {}) as Record<string, any>;
    const event = String(evt.event || '').toLowerCase();
    const messages: NormalizedInboundMessage[] = [];
    const statuses: StatusUpdate[] = [];

    const items: any[] = Array.isArray(evt.data) ? evt.data : evt.data ? [evt.data] : [];

    if (event.includes('messages.update') || event.includes('status')) {
      for (const d of items) {
        const st = STATUS_MAP[String(d?.status || d?.update?.status || '')];
        if (st) statuses.push({ externalMessageId: d?.key?.id || '', status: st, timestamp: new Date() });
      }
      return { messages, statuses, errors: [] };
    }

    // messages.upsert (mensagem recebida)
    for (const d of items) {
      const key = d?.key || {};
      if (key.fromMe) continue; // ignora eco de saída
      const remoteJid = key.remoteJid as string;
      const number = jidToNumber(remoteJid);
      if (!number) continue;

      const m = d?.message || {};
      const text =
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        '';

      let type = MessageContentType.TEXT;
      const content: NormalizedInboundMessage['content'] = {};
      if (text) content.text = text;
      if (m.imageMessage) { type = MessageContentType.IMAGE; content.mimeType = m.imageMessage.mimetype; if (text) content.caption = text; }
      else if (m.audioMessage) { type = MessageContentType.AUDIO; content.mimeType = m.audioMessage.mimetype; }
      else if (m.videoMessage) { type = MessageContentType.VIDEO; content.mimeType = m.videoMessage.mimetype; if (text) content.caption = text; }
      else if (m.documentMessage) { type = MessageContentType.DOCUMENT; content.mimeType = m.documentMessage.mimetype; content.fileName = m.documentMessage.fileName; }

      const tsRaw = d?.messageTimestamp;
      const ts = tsRaw ? new Date(Number(tsRaw) * 1000) : new Date();

      messages.push({
        externalMessageId: key.id || '',
        externalContactId: number,
        contactName: d?.pushName || undefined,
        contactPhone: number,
        channelType: ChannelType.WHATSAPP_EVOLUTION,
        timestamp: isNaN(ts.getTime()) ? new Date() : ts,
        type,
        content,
        isGroup: (remoteJid || '').endsWith('@g.us'),
        rawPayload: d,
      });
    }

    return { messages, statuses, errors: [] };
  }
}
