import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { BotPortalClient } from '../bot-portal/bot-portal.client';
import { BotOtpService } from '../bot-portal/bot-otp.service';
import type { FlowRequest } from './whatsapp-flow-crypto.service';

/** Telas do Flow de agendamento (os ids batem com o JSON publicado no Meta). */
const SCREEN = {
  UNIDADE: 'ESCOLHER_UNIDADE',
  ESPECIALIDADE: 'ESCOLHER_ESPECIALIDADE',
  HORARIO: 'ESCOLHER_HORARIO',
  SUCCESS: 'SUCCESS',
} as const;

type Item = { id: string; title: string; description?: string };

/**
 * Cérebro do Flow de agendamento. O Flow é só a tela — TODAS as regras
 * (permissão, ECG/cardiologia, uma-por-especialidade, vaga ocupada) continuam
 * no portal, porque a confirmação chama o mesmo `/api/bot/agendar` do site.
 *
 * O `flow_token` amarra a tela à CONVERSA (Redis), e o CPF vem da sessão já
 * autenticada por OTP — o Flow nunca recebe nem pede CPF.
 */
@Injectable()
export class WhatsAppFlowService {
  private readonly logger = new Logger(WhatsAppFlowService.name);
  private readonly redis: Redis;
  private readonly TOKEN_TTL = 30 * 60; // 30 min, igual à sessão autenticada

  constructor(
    config: ConfigService,
    private readonly portal: BotPortalClient,
    private readonly otp: BotOtpService,
  ) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
    });
  }

  private tokenKey(t: string) {
    return `flow:token:${t}`;
  }

  /** Cria o flow_token amarrado à conversa (chamado ao ENVIAR o Flow). */
  async createToken(conversationId: string): Promise<string> {
    const token = randomUUID();
    await this.redis.setex(this.tokenKey(token), this.TOKEN_TTL, conversationId);
    return token;
  }

  private async conversationOf(token?: string): Promise<string | null> {
    if (!token) return null;
    return this.redis.get(this.tokenKey(token));
  }

  /** Ponto de entrada do endpoint (payload já descriptografado). */
  async handle(req: FlowRequest): Promise<Record<string, any>> {
    // Health check do Meta.
    if (req.action === 'ping') return { data: { status: 'active' } };

    const conversationId = await this.conversationOf(req.flow_token);
    const cpf = conversationId ? await this.otp.authedCpf(conversationId) : null;
    if (!cpf) {
      return this.errorScreen('Sua sessão expirou. Volte à conversa e confirme sua identidade de novo.');
    }

    try {
      // Abrir o Flow → lista de unidades.
      if (req.action === 'INIT') return await this.screenUnidades();

      const data = req.data || {};
      switch (req.screen) {
        case SCREEN.UNIDADE:
          return await this.screenEspecialidades(String(data.unidade ?? ''));
        case SCREEN.ESPECIALIDADE:
          return await this.screenHorarios(
            String(data.unidade ?? ''),
            String(data.especialidade ?? ''),
          );
        case SCREEN.HORARIO:
          return await this.confirmar(cpf, data);
        default:
          return await this.screenUnidades();
      }
    } catch (err: any) {
      this.logger.error(`Flow falhou (${req.screen}): ${err?.message}`);
      return this.errorScreen('Não consegui carregar agora. Tente novamente em instantes.');
    }
  }

  // ─── Telas ────────────────────────────────────────────────────────────────

  private async screenUnidades(): Promise<Record<string, any>> {
    const r: any = await this.portal.unidades();
    const unidades: Item[] = (r?.unidades ?? []).map((u: any) => ({
      id: String(u.id),
      title: this.titleCase(String(u.nome ?? '')).slice(0, 30),
      description: u.endereco ? this.titleCase(String(u.endereco)).slice(0, 60) : undefined,
    }));
    if (!unidades.length) return this.errorScreen('Nenhuma unidade disponível no momento.');
    return { screen: SCREEN.UNIDADE, data: { unidades } };
  }

  private async screenEspecialidades(unidadeId: string): Promise<Record<string, any>> {
    const r: any = await this.portal.especialidades(Number(unidadeId));
    // Sem limite de 10: o dropdown do Flow lista todas.
    const especialidades: Item[] = (r?.especialidades ?? []).map((e: any) => ({
      id: String(e.id),
      title: this.titleCase(String(e.nome ?? '')).slice(0, 30),
    }));
    if (!especialidades.length) {
      return this.errorScreen('Esta unidade não tem especialidades disponíveis.');
    }
    return { screen: SCREEN.ESPECIALIDADE, data: { unidade: unidadeId, especialidades } };
  }

  private async screenHorarios(
    unidadeId: string,
    especialidadeId: string,
  ): Promise<Record<string, any>> {
    const r: any = await this.portal.horarios(Number(unidadeId), Number(especialidadeId));
    const lista = (r?.horarios ?? []) as any[];
    if (!lista.length) {
      return this.errorScreen('Sem horários livres nesta especialidade agora. Tente outra data ou especialidade.');
    }
    // O Flow mostra tudo numa tela só (limite generoso do componente).
    const horarios: Item[] = lista.slice(0, 100).map((h: any) => ({
      id: String(h.id),
      title: String(h.dtagenda ?? '').slice(0, 30),
      description: h.medico ? `Dr(a). ${this.titleCase(String(h.medico))}`.slice(0, 60) : undefined,
    }));
    return {
      screen: SCREEN.HORARIO,
      data: { unidade: unidadeId, especialidade: especialidadeId, horarios },
    };
  }

  /** Confirmação: chama o MESMO endpoint do site (todas as regras valem). */
  private async confirmar(cpf: string, data: Record<string, any>): Promise<Record<string, any>> {
    const agendaId = Number(data.horario ?? 0);
    if (!agendaId) return this.errorScreen('Escolha um horário para continuar.');

    const r: any = await this.portal.agendar(cpf, agendaId);
    if (r?.ok) {
      // Encerra o Flow; o texto volta pro fluxo do WhatsApp.
      return {
        screen: SCREEN.SUCCESS,
        data: {
          extension_message_response: {
            params: {
              flow_token: data.flow_token ?? '',
              status: r.remarcada ? 'remarcada' : 'agendada',
              agenda_id: String(agendaId),
            },
          },
        },
      };
    }

    // Regra do portal recusou (ECG/cardiologia, uma-por-especialidade,
    // inadimplência, vaga ocupada…) → mostra o MOTIVO na própria tela.
    const motivo = String(r?.error || 'Não foi possível agendar.');
    if (/não está mais disponível/i.test(motivo)) {
      // Vaga ocupada por outro sistema: recarrega a lista de horários.
      const refreshed = await this.screenHorarios(
        String(data.unidade ?? ''),
        String(data.especialidade ?? ''),
      );
      if (refreshed.screen === SCREEN.HORARIO) {
        refreshed.data = {
          ...refreshed.data,
          error_message: 'Esse horário acabou de ser ocupado. Escolha outro.',
        };
      }
      return refreshed;
    }
    return this.errorScreen(motivo);
  }

  private errorScreen(message: string): Record<string, any> {
    // Mantém o usuário na tela atual e mostra o aviso.
    return { screen: SCREEN.UNIDADE, data: { unidades: [], error_message: message } };
  }

  private titleCase(v: string): string {
    const small = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
    return v
      .toLowerCase()
      .split(/\s+/)
      .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  }
}
