import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * Cliente dos endpoints `/api/bot/*` do portal do associado (associados-nextjs).
 * Autenticação server-to-server via header `x-bot-api-key`. As REGRAS de
 * negócio (permissão, ECG, uma-por-especialidade, 48h/4h) vivem no portal —
 * aqui só chamamos. Nunca expõe o segredo ao fluxo/cliente.
 */
@Injectable()
export class BotPortalClient {
  private readonly logger = new Logger(BotPortalClient.name);
  private readonly http: AxiosInstance;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    const baseURL = config.get<string>('BOT_PORTAL_URL') || '';
    const apiKey = config.get<string>('BOT_API_KEY') || '';
    this.enabled = !!baseURL && !!apiKey;
    if (!this.enabled) {
      this.logger.warn('BOT_PORTAL_URL/BOT_API_KEY ausentes — portal do associado desabilitado.');
    }
    this.http = axios.create({
      baseURL: baseURL.replace(/\/$/, ''),
      headers: { 'x-bot-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async post<T = any>(path: string, body: Record<string, any>): Promise<T> {
    if (!this.enabled) throw new Error('Portal do associado não configurado.');
    const { data } = await this.http.post<T>(path, body);
    return data;
  }

  resolve(cpf: string) {
    return this.post('/api/bot/resolve', { cpf });
  }
  mensalidades(cpf: string) {
    return this.post('/api/bot/mensalidades', { cpf });
  }
  unidades() {
    return this.post('/api/bot/unidades', {});
  }
  especialidades(unidadeId: number) {
    return this.post('/api/bot/especialidades', { unidadeId });
  }
  horarios(unidadeId: number, especialidadeId: number) {
    return this.post('/api/bot/horarios', { unidadeId, especialidadeId });
  }
  agendar(cpf: string, agendaId: number) {
    return this.post('/api/bot/agendar', { cpf, agendaId });
  }
  consultas(cpf: string) {
    return this.post('/api/bot/consultas', { cpf });
  }
  confirmar(cpf: string, id: number) {
    return this.post('/api/bot/confirmar', { cpf, id });
  }
  cancelar(cpf: string, id: number) {
    return this.post('/api/bot/cancelar', { cpf, id });
  }
}
