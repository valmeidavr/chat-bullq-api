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
  | 'horarios_dia'
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
  /** Variáveis da sessão do turno atual (usadas nas mensagens de confirmação). */
  private vars: Record<string, any> = {};

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

    this.vars = vars;
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
        case 'horarios_dia':
          data = await this.portal.horarios(
            num(d.unidadeVar || 'unidadeId'),
            num(d.especialidadeVar || 'especialidadeId'),
          );
          if (action === 'horarios_dia') {
            // Filtra pelo dia escolhido — busca fresca, sem cache de sessão.
            const dia = String(vars[d.diaVar || 'diaEscolhido'] ?? '');
            data = {
              ...data,
              horarios: (data?.horarios ?? []).filter(
                (h: any) => String(h.dtagenda ?? '').slice(0, 10) === dia,
              ),
            };
          }
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
      // Agendar: a vaga foi ocupada por outro sistema entre a listagem e o toque
      // (o portal recusa atomicamente). Aresta 'slot_taken' → re-lista horários.
      if (action === 'agendar' && failed && /não está mais disponível/i.test(String(data?.error || ''))) {
        const takenNext = ctx.nodeEdges.find((e) => e.condition === 'slot_taken')?.targetNodeId || errorNext;
        return {
          nextNodeId: takenNext,
          sendMessages: sendAsMessage
            ? [{ type: 'TEXT', content: { text: '⚠️ Esse horário *acabou de ser ocupado* por outra pessoa. Vou te mostrar os horários que ainda estão livres:' } }]
            : [],
          waitForInput: false,
          updatedVariables: { [saveAs]: data, [`${saveAs}_error`]: 'slot_taken' },
        };
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
          { type: 'TEXT', content: { text: 'Não consegui completar essa ação agora. 😕 Tente novamente em instantes.\n\nSe preferir, entre em contato com nossa secretaria pelo telefone (24) 2102-1909, opção 3.' } },
        ],
        waitForInput: false,
        updatedVariables: { [`${saveAs}_error`]: err?.message || 'erro' },
      };
    }
  }

  /**
   * Título curto da unidade (≤24 chars do WhatsApp): tira o prefixo genérico
   * ("Centro de Saúde", "Posto Avançado"…) e corta em limite de palavra.
   * "Centro de Saúde Sebastião Pinheiro Bastos" → "Sebastião Pinheiro".
   */
  private shortUnitName(full: string): string {
    let s = full.replace(/^(centro de sa[uú]de|posto avan[cç]ado|unidade|cl[ií]nica|hospital)\s+/i, '').trim() || full;
    if (s.length <= 24) return s;
    const words = s.split(' ');
    let out = '';
    for (const w of words) {
      if ((out + (out ? ' ' : '') + w).length > 24) break;
      out += (out ? ' ' : '') + w;
    }
    return out || s.slice(0, 24);
  }

  /** "CENTRO DE SAÚDE X" → "Centro De Saúde X" (preposições curtas em minúsculo). */
  private titleCase(v: string): string {
    const small = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
    return String(v)
      .toLowerCase()
      .split(/\s+/)
      .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ')
      .trim();
  }

  private brl(v: number): string {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  private dmy(v: string): string {
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
  }
  /** "01/10/2026" → "Qua," (abreviado, cabe no título da lista). */
  private diaSemana(dmy: string): string {
    const m = String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return '';
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return ['Dom,', 'Seg,', 'Ter,', 'Qua,', 'Qui,', 'Sex,', 'Sáb,'][d.getDay()] ?? '';
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
          // Data completa no título (desambigua meses com mais de uma cobrança).
          label: `${this.dmy(m.vencimento)} — ${this.brl(Number(m.valor))}`,
          description: `Mensalidade ${m.mes || ''}${m.status === 'em_aberto' ? ' • em aberto' : ' • futura'}`.trim(),
        }));
    }
    if (action === 'unidades') {
      // Título do item tem 24 chars no WhatsApp: nome em Título Case; o nome
      // completo + endereço vão na descrição (72 chars).
      return (data?.unidades ?? []).map((u: any) => {
        const full = this.titleCase(String(u.unidade ?? u.nome ?? u.id ?? ''));
        const end = u.endereco ? this.titleCase(String(u.endereco)) : '';
        // Cidade = último trecho depois de " - " no endereço (ex.: "... - Pinheiral").
        const cidade = end.includes(' - ') ? end.split(' - ').pop() : '';
        return {
          value: String(u.id ?? u.unidadeId ?? ''),
          label: this.shortUnitName(full),
          description: [full, cidade].filter(Boolean).join(' • ').slice(0, 72) || undefined,
        };
      });
    }
    if (action === 'especialidades') {
      return (data?.especialidades ?? []).map((e: any) => ({
        value: String(e.id ?? e.especialidadeId ?? ''),
        label: this.titleCase(String(e.nome ?? e.especialidade ?? e.id ?? '')),
      }));
    }
    if (action === 'horarios') {
      // Agrupa por DIA: com até 200 horários, escolher a data primeiro é o
      // único caminho usável. O `value` é o dia (dd/mm/aaaa).
      const porDia = new Map<string, number>();
      for (const h of (data?.horarios ?? []) as any[]) {
        const dia = String(h.dtagenda ?? '').slice(0, 10);
        if (dia) porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
      }
      return [...porDia.entries()].map(([dia, n]) => ({
        value: dia,
        label: `${this.diaSemana(dia)} ${dia.slice(0, 5)}`.trim(),
        description: `${n} horário${n > 1 ? 's' : ''} livre${n > 1 ? 's' : ''}`,
      }));
    }
    if (action === 'horarios_dia') {
      return (data?.horarios ?? []).map((h: any) => ({
        value: String(h.id ?? h.agendaId ?? ''),
        label: String(h.dtagenda ?? '').slice(11, 16) || this.dmyhm(h.dtagenda ?? ''),
        description: h.medico ? `Dr(a). ${this.titleCase(String(h.medico))}` : undefined,
      }));
    }
    if (action === 'consultas') {
      return (data?.consultas ?? []).map((c: any) => {
        const esp = this.titleCase(String(c.especialidade ?? 'Consulta'));
        const med = c.medico ? `Dr(a). ${this.titleCase(String(c.medico))}` : '';
        const uni = c.unidade ? this.titleCase(String(c.unidade)) : '';
        return {
          value: String(c.id ?? ''),
          label: this.dmyhm(c.dtagenda ?? ''),
          description: [esp, med, uni].filter(Boolean).join(' • ').slice(0, 72),
        };
      });
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
      if (!data?.ok) return data?.error || 'Não foi possível agendar.';
      const v = this.vars;
      const linhas = [
        data?.remarcada ? '✅ *Consulta remarcada com sucesso!*' : '✅ *Consulta agendada com sucesso!*',
        '',
        v?.agendaIdLabel ? `📅 ${v.agendaIdLabel}` : '',
        v?.agendaIdDesc ? `👨‍⚕️ ${v.agendaIdDesc}` : '',
        v?.especialidadeIdLabel ? `🩺 ${v.especialidadeIdLabel}` : '',
        v?.unidadeIdDesc || v?.unidadeIdLabel ? `🏥 ${v.unidadeIdDesc || v.unidadeIdLabel}` : '',
        '',
        'Você pode *confirmar* ou *cancelar* em "Minhas consultas". 😊',
      ];
      return linhas.filter((l) => l !== '').join('\n').replace('\n\nVocê pode', '\n\nVocê pode');
    }
    if (action === 'pagar') return data?.ok ? '' : data?.error || 'Não foi possível gerar o pagamento.';
    if (action === 'confirmar') return data?.ok ? 'Consulta confirmada! ✅' : data?.error || 'Não foi possível confirmar.';
    if (action === 'cancelar') return data?.ok ? 'Consulta cancelada. ' : data?.error || 'Não foi possível cancelar.';
    return '';
  }
}
