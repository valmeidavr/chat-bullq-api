import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomInt } from 'crypto';
import { BotPortalClient } from './bot-portal.client';

interface OtpEntry {
  hash: string;
  cpf: string;
  attempts: number;
  /** true = código entregue no número CADASTRADO (usuário em outro celular). */
  viaRegistered?: boolean;
  /** 'otp' = código de 6 dígitos; 'cpf' = completar os 6 dígitos do meio do CPF. */
  kind?: 'otp' | 'cpf';
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
    /** true = WhatsApp atual ≠ cadastrado; entregar o código em `deliverTo`. */
    viaRegistered?: boolean;
    /** Celular cadastrado (só dígitos) pra onde enviar o código. */
    deliverTo?: string;
    /** De quem é o telefone: do próprio associado ou do titular (dependente). */
    phoneSource?: 'proprio' | 'titular';
    titularNome?: string | null;
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

    // Anti-abuso: no máximo 3 códigos por CPF por hora (evita alguém disparar
    // OTP em massa pro celular cadastrado de outra pessoa).
    const rlKey = `bot:otp:rl:${clean}`;
    const tries = await this.redis.incr(rlKey);
    if (tries === 1) await this.redis.expire(rlKey, 3600);
    if (tries > 3) return { ok: false, reason: 'rate_limit', nome: info.primeiroNome };

    const contatoCore = this.core(contactPhone);
    const celCore = this.core(info.celular);
    const telCore = this.core(info.telefone);
    const matches = !!contatoCore && (contatoCore === celCore || contatoCore === telCore);
    // Outro celular: o código vai pro número CADASTRADO (prova de posse mesmo
    // de outro aparelho). Sem número cadastrado, não há como confirmar.
    const registered = String(info.celular || info.telefone || '').replace(/\D/g, '');
    if (!matches && !registered) {
      return { ok: false, reason: 'telefone_nao_confere', masked: info.masked, nome: info.primeiroNome };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const entry: OtpEntry = { hash: this.hash(code), cpf: clean, attempts: 0, viaRegistered: !matches, kind: 'otp' };
    await this.redis.setex(this.otpKey(conversationId), this.OTP_TTL, JSON.stringify(entry));
    this.logger.log(
      `OTP gerado p/ conversa ${conversationId} (cpf ***${clean.slice(-3)}) via ${matches ? 'chat' : 'número cadastrado'}`,
    );
    return {
      ok: true,
      code,
      viaRegistered: !matches,
      deliverTo: matches ? undefined : registered,
      phoneSource: info.phoneSource === 'titular' ? 'titular' : 'proprio',
      titularNome: info.titularNome ?? null,
      masked: info.masked,
      nome: info.primeiroNome,
      podeAgendar: info.podeAgendar !== false,
      motivo: info.motivo ?? null,
      detalhe: info.detalhe ?? undefined,
    };
  }

  /**
   * Login "complete seu CPF": identifica o associado pelo NÚMERO do WhatsApp
   * (posse) e pede os 6 dígitos do meio do CPF (conhecimento). Só quando o
   * número casa com exatamente um associado ativo; senão o fluxo pede o CPF.
   * Guarda o hash dos 6 dígitos (3 tentativas); verify() confere igual ao OTP.
   */
  async startByPhone(
    conversationId: string,
    contactPhone: string,
  ): Promise<{
    ok: boolean;
    reason?: string;
    maskedCpf?: string;
    nome?: string;
    masked?: string;
    podeAgendar?: boolean;
    motivo?: string | null;
    detalhe?: string;
  }> {
    let info: any;
    try {
      info = await this.portal.resolveByPhone(contactPhone);
    } catch (err: any) {
      this.logger.warn(`resolveByPhone falhou: ${err?.message}`);
      return { ok: false, reason: 'portal_indisponivel' };
    }
    const cpf = String(info?.cpf ?? '').replace(/\D/g, '');
    if (!info?.found || cpf.length !== 11) {
      return { ok: false, reason: info?.multiple ? 'multiplos' : 'nao_identificado' };
    }
    const middle = cpf.slice(3, 9); // 6 dígitos do meio
    const maskedCpf = `${cpf.slice(0, 3)}.•••.•••-${cpf.slice(9)}`;
    const entry: OtpEntry = { hash: this.hash(middle), cpf, attempts: 0, kind: 'cpf' };
    await this.redis.setex(this.otpKey(conversationId), this.OTP_TTL, JSON.stringify(entry));
    this.logger.log(`Login por número p/ conversa ${conversationId} (cpf ***${cpf.slice(-3)})`);
    return {
      ok: true,
      maskedCpf,
      nome: info.primeiroNome,
      masked: info.masked,
      podeAgendar: info.podeAgendar !== false,
      motivo: info.motivo ?? null,
      detalhe: info.detalhe ?? undefined,
    };
  }

  async verify(
    conversationId: string,
    code: string,
  ): Promise<{ ok: boolean; cpf?: string; reason?: string; kind?: 'otp' | 'cpf' }> {
    const raw = await this.redis.get(this.otpKey(conversationId));
    if (!raw) return { ok: false, reason: 'expirado' };
    let entry: OtpEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'expirado' };
    }
    const kind = entry.kind || 'otp';
    const maxAttempts = kind === 'cpf' ? 3 : this.MAX_ATTEMPTS;
    if (entry.attempts >= maxAttempts) {
      await this.redis.del(this.otpKey(conversationId));
      return { ok: false, reason: 'muitas_tentativas', kind };
    }
    const clean = String(code).replace(/\D/g, '');
    if (this.hash(clean) !== entry.hash) {
      entry.attempts += 1;
      const ttl = await this.redis.ttl(this.otpKey(conversationId));
      await this.redis.setex(this.otpKey(conversationId), ttl > 0 ? ttl : this.OTP_TTL, JSON.stringify(entry));
      return { ok: false, reason: 'codigo_invalido', kind };
    }
    // Sucesso: marca a conversa como autenticada e limpa o OTP.
    await this.redis.del(this.otpKey(conversationId));
    await this.redis.setex(this.authKey(conversationId), this.AUTH_TTL, entry.cpf);
    return { ok: true, cpf: entry.cpf, kind };
  }

  /** Re-consulta a permissão de agendar (mesma regra do site) de um CPF já autenticado. */
  async refreshPermissao(cpf: string): Promise<{
    podeAgendar?: boolean;
    motivo?: string | null;
    detalhe?: string;
    masked?: string;
    nome?: string;
  }> {
    try {
      const info: any = await this.portal.resolve(cpf);
      return {
        podeAgendar: info?.podeAgendar !== false,
        motivo: info?.motivo ?? null,
        detalhe: info?.detalhe ?? undefined,
        masked: info?.masked,
        nome: info?.primeiroNome,
      };
    } catch {
      return {};
    }
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
