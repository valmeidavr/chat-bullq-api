import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { TwilioContentClient } from '../../../templates/twilio-content.client';

export interface MenuDescriptor {
  header?: string;
  body: string;
  footer?: string;
  buttonText?: string;
  options: { id: string; title: string; description?: string }[];
}

export interface MenuContentResult {
  contentSid: string;
  kind: 'quick-reply' | 'list-picker';
}

/**
 * Cria (e reusa via cache no Redis) o Content template nativo do Twilio pra um
 * menu do chatbot — quick-reply (≤3) ou list-picker (4–10). O cache é por
 * (canal + hash do menu): se o menu muda, um novo Content é criado. Enviável
 * dentro da janela de 24h sem aprovação do WhatsApp.
 */
@Injectable()
export class TwilioMenuContentService {
  private readonly logger = new Logger(TwilioMenuContentService.name);
  private readonly redis: Redis;
  private readonly content = new TwilioContentClient();
  private readonly TTL = 60 * 60 * 24 * 30; // 30 dias

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
    });
  }

  /** Monta o corpo (header + body + footer) e um hash estável do menu. */
  private compose(menu: MenuDescriptor) {
    const body = [menu.header, menu.body, menu.footer]
      .filter((s) => s && String(s).trim())
      .join('\n\n');
    const basis = JSON.stringify({
      body,
      buttonText: menu.buttonText || '',
      options: menu.options.map((o) => [o.id, o.title, o.description || '']),
    });
    const hash = createHash('sha1').update(basis).digest('hex').slice(0, 16);
    return { body, hash };
  }

  private key(channelId: string, hash: string) {
    return `twilio:menu:${channelId}:${hash}`;
  }

  /**
   * Garante um ContentSid pro menu. Usa cache; cria no Twilio se necessário.
   * Lança em erro de criação — o adapter faz fallback pra texto.
   */
  async ensure(
    channelId: string,
    creds: { accountSid: string; authToken: string },
    menu: MenuDescriptor,
    language = 'pt_BR',
  ): Promise<MenuContentResult> {
    const { body, hash } = this.compose(menu);
    const cacheKey = this.key(channelId, hash);

    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as MenuContentResult;
      } catch {
        /* cache corrompido — recria */
      }
    }

    const { sid, kind } = await this.content.createInteractiveMenu(creds, {
      name: `menu_${channelId.slice(0, 8)}_${hash}`,
      language,
      body,
      buttonText: menu.buttonText,
      options: menu.options,
    });

    const result: MenuContentResult = { contentSid: sid, kind };
    await this.redis
      .setex(cacheKey, this.TTL, JSON.stringify(result))
      .catch(() => undefined);
    this.logger.log(`Menu content criado (${kind}) canal=${channelId} sid=${sid}`);
    return result;
  }
}
