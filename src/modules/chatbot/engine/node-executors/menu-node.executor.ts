import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

type Opt = { label: string; value: string; description?: string };

/** WhatsApp aceita no máx. 10 itens por lista; com paginação: 9 + "Ver mais". */
const MAX_ROWS = 10;
const PAGE_SIZE = 9;
const MORE_ID = '__more__';

@Injectable()
export class MenuNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MENU';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as {
      title: string;
      header?: string;
      footer?: string;
      buttonText?: string;
      options: Opt[];
      /** Menu dinâmico: monta as opções a partir de uma variável (lista vinda da API). */
      optionsFrom?: string;
      /** Salva o valor escolhido nesta variável (útil no menu dinâmico p/ o próximo nó). */
      saveAs?: string;
      /** Mensagem enviada SÓ quando a lista dinâmica vem vazia (não é rodapé). */
      emptyMessage?: string;
    };
    const vars = ctx.session.variables;
    const title = d.title || 'Escolha uma opção:';

    // Menu dinâmico: opções vêm de uma variável (ex.: PORTAL_ACTION que listou
    // especialidades/horários). Normaliza pra {label,value,description}.
    const dynamic = !!d.optionsFrom;
    const options: Opt[] = dynamic ? this.normalize(vars[d.optionsFrom as string]) : d.options || [];
    const canGoBack = (ctx.session.menuHistory?.length ?? 0) > 0;

    if (dynamic && options.length === 0 && !ctx.incomingMessage) {
      // Sem itens → aresta 'empty' se existir (senão a 1ª). O fluxo trata o vazio.
      const emptyEdge = ctx.nodeEdges.find((e) => e.condition === 'empty');
      return {
        nextNodeId: emptyEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null,
        sendMessages: [{ type: 'TEXT', content: { text: d.emptyMessage || 'Nada disponível no momento.' } }],
        waitForInput: false,
      };
    }

    // Paginação (só quando passa de 10): página atual guardada na sessão.
    const pageKey = `_menuPage_${ctx.session.currentNodeId}`;
    const paginate = options.length > MAX_ROWS;
    const pageOf = (pg: number) => {
      if (!paginate) return { slice: options, hasMore: false };
      const start = pg * PAGE_SIZE;
      return { slice: options.slice(start, start + PAGE_SIZE), hasMore: start + PAGE_SIZE < options.length };
    };

    const render = (pg: number): NodeExecutionResult => {
      const { slice, hasMore } = pageOf(pg);
      const lines = [title, '', ...slice.map((opt, i) => `${i + 1}. ${opt.label}`)];
      if (hasMore) lines.push(`${slice.length + 1}. Ver mais ▶`);
      if (canGoBack) lines.push('0. Voltar');
      if (paginate) lines.push('', `Página ${pg + 1} de ${Math.ceil(options.length / PAGE_SIZE)}`);

      // Descritor de UI nativa (WhatsApp): o adapter que suportar (Twilio/Meta →
      // botões/lista) renderiza isso; os demais canais usam o `text` acima.
      const nativeOptions = slice.map((o) => ({ id: o.value, title: o.label, description: o.description }));
      if (hasMore) nativeOptions.push({ id: MORE_ID, title: 'Ver mais ▶', description: `Página ${pg + 2}` });
      if (canGoBack && nativeOptions.length < MAX_ROWS) {
        nativeOptions.push({ id: 'voltar', title: '⬅️ Voltar', description: undefined });
      }
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
                options: nativeOptions,
              },
            },
          },
        ],
        waitForInput: true,
        updatedVariables: { [pageKey]: pg },
      };
    };

    // Entrada no nó (sem resposta pendente): renderiza a 1ª página.
    if (!ctx.incomingMessage) return render(0);

    const input = ctx.incomingMessage.trim();
    const page = Number(vars[pageKey]) || 0;
    const { slice, hasMore } = pageOf(page);

    // "Ver mais" (toque no item ou número da posição) → próxima página.
    if (hasMore && (input === MORE_ID || parseInt(input, 10) === slice.length + 1)) {
      return render(page + 1);
    }

    const selectedIndex = parseInt(input, 10) - 1;
    const selectedByNumber = slice[selectedIndex];
    const selectedByValue = options.find(
      (o) => o.value.toLowerCase() === input.toLowerCase() || o.label.toLowerCase() === input.toLowerCase(),
    );
    const selected = selectedByNumber || selectedByValue;

    if (!selected) {
      // Modo "Fluxo + IA juntos": em vez de "opção inválida", deixa a IA de
      // apoio responder a pergunta solta e o engine re-exibe o menu.
      if (ctx.aiAssist) {
        return { nextNodeId: null, sendMessages: [], waitForInput: true, aiAssistText: input };
      }
      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: 'Opção inválida. Tente novamente.' } }],
        waitForInput: true,
      };
    }

    // Menu dinâmico: sem ramificar por condição — salva a escolha e segue.
    // Menu estático: ramifica pela aresta cuja condição = value da opção.
    const nextNodeId = dynamic
      ? (ctx.nodeEdges.find((e) => e.condition !== 'empty') ?? ctx.nodeEdges[0])?.targetNodeId || null
      : ctx.nodeEdges.find((e) => e.condition === selected.value)?.targetNodeId ||
        ctx.nodeEdges[0]?.targetNodeId ||
        null;

    const updatedVariables: Record<string, any> = { lastMenuSelection: selected.value, [pageKey]: 0 };
    if (d.saveAs) updatedVariables[d.saveAs] = selected.value;

    return { nextNodeId, sendMessages: [], waitForInput: false, updatedVariables };
  }

  /** Normaliza uma lista qualquer em opções de menu {label,value,description}. */
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
