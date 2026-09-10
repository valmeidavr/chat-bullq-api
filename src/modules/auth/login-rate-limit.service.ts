import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Trava de força bruta no login. Duas janelas independentes no Redis:
 *  - por E-MAIL (5 falhas / 15 min): protege a senha de uma conta específica.
 *  - por IP     (20 falhas / 15 min): protege contra varredura de vários e-mails.
 * Só falhas contam; login certo zera o contador do e-mail. Sem Redis (ou com
 * Redis fora do ar) o login continua funcionando — fail-open de propósito, pra
 * um problema de infra não derrubar o acesso de todo mundo.
 */
@Injectable()
export class LoginRateLimitService {
  private readonly logger = new Logger(LoginRateLimitService.name);
  private readonly redis: Redis;

  private readonly WINDOW = 15 * 60; // 15 min
  private readonly MAX_PER_EMAIL = 5;
  private readonly MAX_PER_IP = 20;

  constructor(config: ConfigService) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      // Não deixa o cliente enfileirar comandos quando o Redis cai.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', (e) => this.logger.warn(`Redis (login guard): ${e.message}`));
  }

  private emailKey(email: string) {
    return `login:fail:email:${email.toLowerCase().trim()}`;
  }
  private ipKey(ip: string) {
    return `login:fail:ip:${ip}`;
  }

  /** Chamado ANTES de validar a senha. Lança 429 se estourou a janela. */
  async assertAllowed(email: string, ip: string): Promise<void> {
    try {
      const [emailFails, ipFails] = await Promise.all([
        this.redis.get(this.emailKey(email)),
        this.redis.get(this.ipKey(ip)),
      ]);

      if (Number(emailFails) >= this.MAX_PER_EMAIL) {
        const ttl = await this.redis.ttl(this.emailKey(email));
        this.logger.warn(`Login bloqueado (e-mail): ${email} de ${ip}`);
        throw this.tooMany(ttl);
      }
      if (Number(ipFails) >= this.MAX_PER_IP) {
        const ttl = await this.redis.ttl(this.ipKey(ip));
        this.logger.warn(`Login bloqueado (IP): ${ip}`);
        throw this.tooMany(ttl);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis indisponível → não bloqueia o login (fail-open).
      this.logger.warn(`Login guard indisponível: ${(err as Error).message}`);
    }
  }

  /** Registra uma tentativa que falhou (senha errada ou usuário inexistente). */
  async registerFailure(email: string, ip: string): Promise<void> {
    try {
      const ek = this.emailKey(email);
      const ik = this.ipKey(ip);
      const [emailCount, ipCount] = await Promise.all([
        this.redis.incr(ek),
        this.redis.incr(ik),
      ]);
      // Só define o TTL na primeira falha (janela deslizante por bloco).
      if (emailCount === 1) await this.redis.expire(ek, this.WINDOW);
      if (ipCount === 1) await this.redis.expire(ik, this.WINDOW);
    } catch (err) {
      this.logger.warn(`Login guard (registerFailure): ${(err as Error).message}`);
    }
  }

  /** Login certo → zera o contador daquele e-mail. */
  async registerSuccess(email: string): Promise<void> {
    try {
      await this.redis.del(this.emailKey(email));
    } catch {
      /* irrelevante se falhar */
    }
  }

  private tooMany(ttlSeconds: number): HttpException {
    const min = Math.max(1, Math.ceil((ttlSeconds > 0 ? ttlSeconds : this.WINDOW) / 60));
    return new HttpException(
      `Muitas tentativas de login. Tente novamente em ${min} minuto${min > 1 ? 's' : ''}.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
