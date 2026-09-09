import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class MenuNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MENU';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as {
      title: string;
      header?: string;
      footer?: string;
      buttonText?: string;
      options: { label: string; value: string; description?: string }[];
      /** Menu dinâmico: monta as opções a partir de uma variável (lista vinda da API). */
      optionsFrom?: string;
      /** Salva o valor escolhido nesta variável (útil no menu dinâmico p/ o próximo nó). */
      saveAs?: string;
    };
    const title = d.title;

    // Menu dinâmico: opções vêm de uma variável (ex.: PORTAL_ACTION que listou
    // especialidades/horários). Normaliza pra {label,value,description}.
    const dynamic = !!d.optionsFrom;
    const options: { label: string; value: string; description?: string }[] = dynamic
      ? this.normalize(ctx.session.variables[d.optionsFrom as string])
      : d.options || [];

    if (dynamic && options.length === 0 && !ctx.incomingMessage) {
      // Sem itens → aresta 'empty' se existir (senão a 1ª). O fluxo trata o vazio.
      const emptyEdge = ctx.nodeEdges.find((e) => e.condition === 'empty');
      return {
        nextNodeId: emptyEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null,
        sendMessages: [{ type: 'TEXT', content: { text: d.footer || 'Nada disponível no momento.' } }],
        waitForInput: false,
      };
    }

    const canGoBack = (ctx.session.menuHistory?.length ?? 0) > 0;

    if (!ctx.incomingMessage) {
      const lines = [
        title || 'Escolha uma opção:',
        '',
        ...options.map((opt, i) => `${i + 1}. ${opt.label}`),
      ];
      if (canGoBack) lines.push('0. Voltar');
      const menuText = lines.join('\n');

      // Descritor de UI nativa (WhatsApp): o adapter que suportar (Twilio →
      // botões/lista) renderiza isso; os demais canais usam o `text` acima.
      const nativeOptions = options.map((o) => ({
        id: o.value,
        title: o.label,
        description: o.description,
      }));
      if (canGoBack) nativeOptions.push({ id: 'voltar', title: '⬅️ Voltar', description: undefined });

      return {
        nextNodeId: null,
        sendMessages: [
          {
            type: 'TEXT',
            content: {
              text: menuText,
              interactiveMenu: {
                header: d.header,
                body: title || 'Escolha uma opção:',
                footer: d.footer,
                buttonText: d.buttonText,
                options: nativeOptions,
              },
            },
          },
        ],
        waitForInput: true,
      };
    }

    const input = ctx.incomingMessage.trim();
    const selectedIndex = parseInt(input, 10) - 1;
    const selectedByNumber = options[selectedIndex];
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

    const updatedVariables: Record<string, any> = { lastMenuSelection: selected.value };
    if (d.saveAs) updatedVariables[d.saveAs] = selected.value;

    return { nextNodeId, sendMessages: [], waitForInput: false, updatedVariables };
  }

  /** Normaliza uma lista qualquer em opções de menu {label,value,description}. */
  private normalize(v: any): { label: string; value: string; description?: string }[] {
    if (!Array.isArray(v)) return [];
    const out: { label: string; value: string; description?: string }[] = [];
    for (const o of v) {
      if (o == null) continue;
      const value = String(o.value ?? o.id ?? o.agendaId ?? o.consultaId ?? '');
      if (!value) continue;
      const label = String(o.label ?? o.title ?? o.nome ?? o.especialidade ?? o.unidade ?? value);
      const description = o.description ?? o.detalhe ?? o.subtitle;
      out.push(description ? { label, value, description: String(description) } : { label, value });
      if (out.length >= 10) break;
    }
    return out;
  }
}
