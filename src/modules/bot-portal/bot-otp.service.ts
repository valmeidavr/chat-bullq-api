import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomInt } from 'crypto';
import { BotPortalClient } from './bot-portal.client';

interface OtpEntry {
  hash: string;
  cpf: string;
  attempts: number;
}

/**
 * OTP do bot (Fase 2). Fluxo: informa CPF → confere se o WhatsApp de origem
 * bate com o celular cadastrado no CRM (via portal /resolve) → gera código de
 * 6 dígitos, guarda o HASH no Redis (10 min) e devolve o código pro chat-api
 * enviar na conversa. Verificação: confere o hash (máx. 5 tentativas) e, no
 * sucesso, marca a conversa como autenticada (cpf, 30 min).
 */
@Injectable()
export class BotOtpService {
  private readonly logger = new Logger(BotOtpService.name);
  private readonly redis: Redis;
  private readonly OTP_TTL = 600; // 10 min
  private readonly AUTH_TTL = 1800; // 30 min
  private readonly MAX_ATTEMPTS = 5;

  constructor(
    private readonly config: ConfigService,
    private readonly portal: BotPortalClient,
  ) {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
    });
  }

  private otpKey(c: string) {
    return `bot:otp:${c}`;
  }
  private authKey(c: string) {
    return `bot:auth:${c}`;
  }
  private hash(code: string) {
    return createHash('sha256').update(code).digest('hex');
  }
  /** Só dígitos, últimos 8 (núcleo do número) — robusto a DDI 55 e ao 9º dígito. */
  private core(phone: string | null | undefined): string {
    return String(phone ?? '').replace(/\D/g, '').slice(-8);
  }

  /**
   * Inicia o OTP: valida CPF+telefone no portal e gera o código. Retorna o
   * código pro chat-api enviar (a entrega é pela própria conversa do WhatsApp,
   * cujo número já foi conferido com o cadastro).
   */
  async start(
    conversationId: string,
    contactPhone: string,
    cpf: string,
  ): Promise<{
    ok: boolean;
    code?: string;
    masked?: string;
    nome?: string;
    reason?: string;
    detalhe?: string;
    /** Permissão de agendar (mesma regra do site: avaliarPermissaoAgendar). */
    podeAgendar?: boolean;
    motivo?: string | null;
  }> {
    const clean = String(cpf).replace(/\D/g, '');
    if (clean.length !== 11) return { ok: false, reason: 'cpf_invalido' };

    let info: any;
    try {
      info = await this.portal.resolve(clean);
    } catch (err: any) {
      this.logger.warn(`OTP resolve falhou: ${err?.message}`);
      return { ok: false, reason: 'portal_indisponivel' };
    }
    if (!info?.exists) return { ok: false, reason: 'nao_encontrado' };

    const contatoCore = this.core(contactPhone);
    const celCore = this.core(info.celular);
    const telCore = this.core(info.telefone);
    if (!contatoCore || (contatoCore !== celCore && contatoCore !== telCore)) {
      return { ok: false, reason: 'telefone_nao_confere', masked: info.masked, nome: info.primeiroNome };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const entry: OtpEntry = { hash: this.hash(code), cpf: clean, attempts: 0 };
    await this.redis.setex(this.otpKey(conversationId), this.OTP_TTL, JSON.stringify(entry));
    this.logger.log(`OTP gerado p/ conversa ${conversationId} (cpf ***${clean.slice(-3)})`);
    return {
      ok: true,
      code,
      masked: info.masked,
      nome: info.primeiroNome,
      podeAgendar: info.podeAgendar !== false,
      motivo: info.motivo ?? null,
      detalhe: info.detalhe ?? undefined,
    };
  }

  async verify(
    conversationId: string,
    code: string,
  ): Promise<{ ok: boolean; cpf?: string; reason?: string }> {
    const raw = await this.redis.get(this.otpKey(conversationId));
    if (!raw) return { ok: false, reason: 'expirado' };
    let entry: OtpEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'expirado' };
    }
    if (entry.attempts >= this.MAX_ATTEMPTS) {
      await this.redis.del(this.otpKey(conversationId));
      return { ok: false, reason: 'muitas_tentativas' };
    }
    const clean = String(code).replace(/\D/g, '');
    if (this.hash(clean) !== entry.hash) {
      entry.attempts += 1;
      const ttl = await this.redis.ttl(this.otpKey(conversationId));
      await this.redis.setex(this.otpKey(conversationId), ttl > 0 ? ttl : this.OTP_TTL, JSON.stringify(entry));
      return { ok: false, reason: 'codigo_invalido' };
    }
    // Sucesso: marca a conversa como autenticada e limpa o OTP.
    await this.redis.del(this.otpKey(conversationId));
    await this.redis.setex(this.authKey(conversationId), this.AUTH_TTL, entry.cpf);
    return { ok: true, cpf: entry.cpf };
  }

  /** CPF autenticado da conversa (ou null). Renova o TTL a cada uso. */
  async authedCpf(conversationId: string): Promise<string | null> {
    const cpf = await this.redis.get(this.authKey(conversationId));
    if (cpf) await this.redis.expire(this.authKey(conversationId), this.AUTH_TTL);
    return cpf;
  }

  async logout(conversationId: string): Promise<void> {
    await this.redis.del(this.authKey(conversationId), this.otpKey(conversationId));
  }
}
