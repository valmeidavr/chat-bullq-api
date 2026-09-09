import { Injectable, Logger } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { BotPortalClient } from '../../../bot-portal/bot-portal.client';
import { BotOtpService } from '../../../bot-portal/bot-otp.service';

type PortalAction =
  | 'mensalidades'
  | 'unidades'
  | 'especialidades'
  | 'horarios'
  | 'agendar'
  | 'consultas'
  | 'confirmar'
  | 'cancelar'
  | 'pagar';

/**
 * Nó PORTAL_ACTION: executa uma ação no portal do associado reusando as REGRAS
 * do site (permissão, ECG, uma-por-especialidade, 48h/4h — tudo no portal).
 * Exige a conversa autenticada (OTP) para ações por CPF. Salva a resposta numa
 * variável e ramifica 'success'/'error'. nodeData: { action, saveAs?,
 * sendAsMessage?, unidadeVar?, especialidadeVar?, agendaVar?, idVar? }.
 */
@Injectable()
export class PortalActionNodeExecutor implements NodeExecutor {
  readonly nodeType = 'PORTAL_ACTION';
  private readonly logger = new Logger(PortalActionNodeExecutor.name);

  constructor(
    private readonly portal: BotPortalClient,
    private readonly otp: BotOtpService,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as Record<string, any>;
    const action = d.action as PortalAction;
    const saveAs = (d.saveAs as string) || 'portalData';
    const sendAsMessage = d.sendAsMessage !== false;
    const vars = ctx.session.variables;

    const successEdge = ctx.nodeEdges.find((e) => e.condition === 'success');
    const errorEdge = ctx.nodeEdges.find((e) => e.condition === 'error');
    const successNext = successEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;
    const errorNext = errorEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || successNext;

    const needsCpf = ['mensalidades', 'agendar', 'consultas', 'confirmar', 'cancelar', 'pagar'].includes(action);
    const cpf = needsCpf ? await this.otp.authedCpf(ctx.conversationId) : null;
    if (needsCpf && !cpf) {
      return {
        nextNodeId: errorNext,
        sendMessages: [
          { type: 'TEXT', content: { text: 'Sua sessão expirou. Vamos confirmar sua identidade de novo?' } },
        ],
        waitForInput: false,
        updatedVariables: { [`${saveAs}_error`]: 'nao_autenticado' },
      };
    }

    const num = (v: any) => Number(vars[v]);
    try {
      let data: any;
      switch (action) {
        case 'mensalidades':
          data = await this.portal.mensalidades(cpf!);
          break;
        case 'unidades':
          data = await this.portal.unidades();
          break;
        case 'especialidades':
          data = await this.portal.especialidades(num(d.unidadeVar || 'unidadeId'));
          break;
        case 'horarios':
          data = await this.portal.horarios(num(d.unidadeVar || 'unidadeId'), num(d.especialidadeVar || 'especialidadeId'));
          break;
        case 'agendar':
          data = await this.portal.agendar(cpf!, num(d.agendaVar || 'agendaId'));
          break;
        case 'consultas':
          data = await this.portal.consultas(cpf!);
          break;
        case 'confirmar':
          data = await this.portal.confirmar(cpf!, num(d.idVar || 'consultaId'));
          break;
        case 'cancelar':
          data = await this.portal.cancelar(cpf!, num(d.idVar || 'consultaId'));
          break;
        case 'pagar':
          data = await this.portal.pagar(cpf!, num(d.idVar || 'contribuicaoId'));
          break;
        default:
          throw new Error(`ação inválida: ${action}`);
      }

      // Ações que retornam {ok:false,error} do portal contam como erro.
      const failed = data && data.ok === false;
      if (action === 'pagar' && data?.ok && sendAsMessage) {
        const valor = this.brl(Number(data.valor_total || 0) / 100);
        const ref = (data.meses || []).join(', ');
        const msgs: { type: string; content: Record<string, any> }[] = [
          { type: 'TEXT', content: { text: `💰 *Mensalidade ${ref}* — ${valor}${data.vencimento ? ` (vence ${data.vencimento})` : ''}\n\nPague por *Pix copia e cola* (toque e segure na próxima mensagem pra copiar):` } },
          { type: 'TEXT', content: { text: String(data.brcode || '') } },
        ];
        if (data.qr_image) msgs.push({ type: 'IMAGE', content: { mediaUrl: String(data.qr_image), caption: 'QR Code Pix — escaneie no app do seu banco' } });
        if (data.boleto_pdf) msgs.push({ type: 'TEXT', content: { text: `📄 Prefere *boleto*? Baixe aqui: ${data.boleto_pdf}` } });
        return { nextNodeId: successNext, sendMessages: msgs, waitForInput: false, updatedVariables: { [saveAs]: data } };
      }
      const text = sendAsMessage ? this.format(action, data) : '';
      const updated: Record<string, any> = { [saveAs]: data };
      // Ações de LISTA também expõem `<saveAs>Options` (pronto pra menu dinâmico).
      const opts = this.optionsFor(action, data);
      if (opts) updated[`${saveAs}Options`] = opts;
      return {
        nextNodeId: failed ? errorNext : successNext,
        sendMessages: text ? [{ type: 'TEXT', content: { text } }] : [],
        waitForInput: false,
        updatedVariables: updated,
      };
    } catch (err: any) {
      this.logger.warn(`PORTAL_ACTION ${action} falhou: ${err?.message}`);
      return {
        nextNodeId: errorNext,
        sendMessages: [
          { type: 'TEXT', content: { text: 'Não consegui completar agora. Tente novamente ou ligue (24) 2102-1909.' } },
        ],
        waitForInput: false,
        updatedVariables: { [`${saveAs}_error`]: err?.message || 'erro' },
      };
    }
  }

  private brl(v: number): string {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  private dmy(v: string): string {
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
  }
  private dmyhm(v: string): string {
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(v);
  }

  /** Converte listas do portal em opções de menu {value,label,description}. */
  private optionsFor(action: PortalAction, data: any): { value: string; label: string; description?: string }[] | null {
    if (action === 'mensalidades') {
      const all = [...(data?.emAberto ?? []), ...(data?.futuras ?? [])] as any[];
      return all
        .filter((m) => Number(m.situacaoId) === 3 && m.id)
        .map((m) => ({
          value: String(m.id),
          label: `${m.mes || this.dmy(m.vencimento)} — ${this.brl(Number(m.valor))}`,
          description: `Vence ${this.dmy(m.vencimento)}${m.status === 'em_aberto' ? ' • em aberto' : ''}`,
        }));
    }
    if (action === 'unidades') {
      return (data?.unidades ?? []).map((u: any) => ({
        value: String(u.id ?? u.unidadeId ?? ''),
        label: String(u.unidade ?? u.nome ?? u.id ?? ''),
        description: u.endereco || undefined,
      }));
    }
    if (action === 'especialidades') {
      return (data?.especialidades ?? []).map((e: any) => ({
        value: String(e.id ?? e.especialidadeId ?? ''),
        label: String(e.nome ?? e.especialidade ?? e.id ?? ''),
      }));
    }
    if (action === 'horarios') {
      return (data?.horarios ?? []).map((h: any) => ({
        value: String(h.id ?? h.agendaId ?? ''),
        label: this.dmyhm(h.dtagenda ?? h.data ?? ''),
        description: h.especialidade || h.medico || h.profissional || undefined,
      }));
    }
    if (action === 'consultas') {
      return (data?.consultas ?? []).map((c: any) => ({
        value: String(c.id ?? ''),
        label: `${c.especialidade ?? 'Consulta'} — ${this.dmyhm(c.dtagenda ?? '')}`,
        description: c.unidade || undefined,
      }));
    }
    return null;
  }

  private format(action: PortalAction, data: any): string {
    if (action === 'mensalidades') {
      const ab = (data?.emAberto ?? []) as any[];
      const fu = (data?.futuras ?? []) as any[];
      if (!ab.length && !fu.length) return 'Você não tem mensalidades em aberto nem futuras. 🎉';
      const lines: string[] = [];
      if (ab.length) {
        lines.push('*Em aberto:*');
        ab.forEach((m) => lines.push(`• Venc. ${this.dmy(m.vencimento)} — ${this.brl(Number(m.valor))}`));
      }
      if (fu.length) {
        lines.push('', '*Futuras:*');
        fu.forEach((m) => lines.push(`• Venc. ${this.dmy(m.vencimento)} — ${this.brl(Number(m.valor))}`));
      }
      if (data?.isDependente && data?.titularNome) {
        lines.push('', `_Contribuições do titular: ${data.titularNome}._`);
      }
      return lines.join('\n');
    }
    if (action === 'consultas') {
      const cs = (data?.consultas ?? []) as any[];
      if (!cs.length) return 'Você não tem consultas agendadas no momento.';
      return ['*Suas consultas:*', ...cs.map((c, i) =>
        `${i + 1}) ${c.especialidade} — ${this.dmyhm(c.dtagenda)} (${c.unidade}) — ${c.situacao === 'confirmada' ? '✅ confirmada' : '🕐 agendada'}`,
      )].join('\n');
    }
    if (action === 'agendar') {
      if (data?.ok) return data?.remarcada
        ? 'Consulta remarcada com sucesso! ✅'
        : 'Consulta agendada com sucesso! ✅';
      return data?.error || 'Não foi possível agendar.';
    }
    if (action === 'pagar') return data?.ok ? '' : data?.error || 'Não foi possível gerar o pagamento.';
    if (action === 'confirmar') return data?.ok ? 'Consulta confirmada! ✅' : data?.error || 'Não foi possível confirmar.';
    if (action === 'cancelar') return data?.ok ? 'Consulta cancelada. ' : data?.error || 'Não foi possível cancelar.';
    return '';
  }
}
