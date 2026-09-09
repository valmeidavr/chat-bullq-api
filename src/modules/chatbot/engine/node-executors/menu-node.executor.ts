import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';
import { BotOtpService } from '../../../bot-portal/bot-otp.service';

type Opt = { label: string; value: string; description?: string };

/** WhatsApp aceita no máx. 10 linhas por lista. */
const MAX_ROWS = 10;
const MORE_ID = '__more__';
const END_ID = '__end__';
const BACK_ID = 'voltar';
const END_WORDS = ['encerrar', 'finalizar', 'encerrar atendimento', 'finalizar atendimento', 'sair'];

@Injectable()
export class MenuNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MENU';

  constructor(private readonly otp: BotOtpService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as {
      title: string;
      header?: string;
      footer?: string;
      buttonText?: string;
      options: Opt[];
      /** Menu dinâmico: monta as opções a partir de uma variável (lista da API). */
      optionsFrom?: string;
      /** Salva o valor escolhido nesta variável (e o texto em `<saveAs>Label`). */
      saveAs?: string;
      /** Mensagem enviada SÓ quando a lista dinâmica vem vazia (não é rodapé). */
      emptyMessage?: string;
      /** Mostrar "Encerrar atendimento" (padrão: sim). */
      showEnd?: boolean;
    };
    const vars = ctx.session.variables;
    const title = d.title || 'Escolha uma opção:';

    const dynamic = !!d.optionsFrom;
    const options: Opt[] = dynamic ? this.normalize(vars[d.optionsFrom as string]) : d.options || [];
    const canGoBack = (ctx.session.menuHistory?.length ?? 0) > 0;
    const showEnd = d.showEnd !== false;

    if (dynamic && options.length === 0 && !ctx.incomingMessage) {
      const emptyEdge = ctx.nodeEdges.find((e) => e.condition === 'empty');
      return {
        nextNodeId: emptyEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null,
        sendMessages: [{ type: 'TEXT', content: { text: d.emptyMessage || 'Nada disponível no momento.' } }],
        waitForInput: false,
      };
    }

    // Linhas fixas (Voltar/Encerrar) reduzem o espaço dos itens na lista nativa.
    const fixedRows = (canGoBack ? 1 : 0) + (showEnd ? 1 : 0);
    const paginate = options.length > MAX_ROWS - fixedRows;
    const pageSize = Math.max(1, MAX_ROWS - fixedRows - (paginate ? 1 : 0));
    const totalPages = Math.max(1, Math.ceil(options.length / pageSize));
    const pageKey = `_menuPage_${ctx.session.currentNodeId}`;
    const pageOf = (pg: number) => {
      if (!paginate) return { slice: options, hasMore: false };
      const start = pg * pageSize;
      return { slice: options.slice(start, start + pageSize), hasMore: start + pageSize < options.length };
    };

    const render = (pg: number): NodeExecutionResult => {
      const { slice, hasMore } = pageOf(pg);
      const lines = [title, '', ...slice.map((o, i) => `${i + 1}. ${o.label}`)];
      let n = slice.length;
      if (hasMore) lines.push(`${++n}. Ver mais ▶`);
      if (canGoBack) lines.push('0. Voltar');
      if (showEnd) lines.push('*encerrar* — finalizar atendimento');
      if (paginate) lines.push('', `Página ${pg + 1} de ${totalPages}`);

      const nativeOptions = slice.map((o) => ({ id: o.value, title: o.label, description: o.description }));
      if (hasMore) nativeOptions.push({ id: MORE_ID, title: 'Ver mais ▶', description: `Página ${pg + 2} de ${totalPages}` });
      if (canGoBack) nativeOptions.push({ id: BACK_ID, title: '⬅️ Voltar', description: 'Escolher outra opção' });
      if (showEnd) nativeOptions.push({ id: END_ID, title: '🔚 Encerrar atendimento', description: 'Finaliza e recomeça do início' });

      return {
        nextNodeId: null,
        sendMessages: [
          {
            type: 'TEXT',
            content: {
              text: lines.join('\n'),
              interactiveMenu: {
                header: d.header,
                body: title,
                footer: d.footer,
                buttonText: d.buttonText,
                options: nativeOptions.slice(0, MAX_ROWS),
              },
            },
          },
        ],
        waitForInput: true,
        updatedVariables: { [pageKey]: pg },
      };
    };

    if (!ctx.incomingMessage) return render(0);

    const input = ctx.incomingMessage.trim();
    const lower = input.toLowerCase();
    const page = Number(vars[pageKey]) || 0;
    const { slice, hasMore } = pageOf(page);

    // Encerrar atendimento: desfaz o login (CPF) e limpa o fluxo — a próxima
    // mensagem recomeça do início e pede identificação de novo.
    if (input === END_ID || END_WORDS.includes(lower)) {
      await this.otp.logout(ctx.conversationId).catch(() => undefined);
      return {
        nextNodeId: null,
        sendMessages: [
          {
            type: 'TEXT',
            content: {
              text: 'Atendimento encerrado. ✅ Obrigado por falar com a AAP-VR!\n\nQuando quiser, é só mandar uma mensagem que começamos de novo. 😊',
            },
          },
        ],
        waitForInput: false,
        endSession: true,
      };
    }

    if (hasMore && (input === MORE_ID || parseInt(input, 10) === slice.length + 1)) return render(page + 1);

    const selectedIndex = parseInt(input, 10) - 1;
    const selected =
      slice[selectedIndex] ||
      options.find((o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower);

    if (!selected) {
      if (ctx.aiAssist) {
        return { nextNodeId: null, sendMessages: [], waitForInput: true, aiAssistText: input };
      }
      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: 'Não entendi essa opção. 🤔 Toque em *Ver opções* e escolha uma da lista.' } }],
        waitForInput: true,
      };
    }

    const nextNodeId = dynamic
      ? (ctx.nodeEdges.find((e) => e.condition !== 'empty') ?? ctx.nodeEdges[0])?.targetNodeId || null
      : ctx.nodeEdges.find((e) => e.condition === selected.value)?.targetNodeId ||
        ctx.nodeEdges[0]?.targetNodeId ||
        null;

    const updatedVariables: Record<string, any> = { lastMenuSelection: selected.value, [pageKey]: 0 };
    if (d.saveAs) {
      updatedVariables[d.saveAs] = selected.value;
      // Guarda o texto escolhido — usado nas confirmações ("agendado para …").
      updatedVariables[`${d.saveAs}Label`] = selected.label;
      if (selected.description) updatedVariables[`${d.saveAs}Desc`] = selected.description;
    }

    return { nextNodeId, sendMessages: [], waitForInput: false, updatedVariables };
  }

  private normalize(v: any): Opt[] {
    if (!Array.isArray(v)) return [];
    const out: Opt[] = [];
    for (const o of v) {
      if (o == null) continue;
      const value = String(o.value ?? o.id ?? o.agendaId ?? o.consultaId ?? '');
      if (!value) continue;
      const label = String(o.label ?? o.title ?? o.nome ?? o.especialidade ?? o.unidade ?? value);
      const description = o.description ?? o.detalhe ?? o.subtitle;
      out.push(description ? { label, value, description: String(description) } : { label, value });
    }
    return out;
  }
}
