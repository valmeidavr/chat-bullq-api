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
    };
    const { options } = d;
    const title = d.title;

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

    const matchingEdge = ctx.nodeEdges.find((e) => e.condition === selected.value);
    const nextNodeId = matchingEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;

    return {
      nextNodeId,
      sendMessages: [],
      waitForInput: false,
      updatedVariables: { lastMenuSelection: selected.value },
    };
  }
}
