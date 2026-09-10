import { Injectable, Logger } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { FlowSendService } from '../../../whatsapp-flow/flow-send.service';

/**
 * Nó FLOW: envia um WhatsApp Flow (formulário nativo) quando o canal suporta —
 * unidade, especialidade e horário numa tela só, sem paginação.
 *
 * Se o canal NÃO suporta (Evolution, Zappfy, ou Flow não configurado), segue
 * pela aresta 'fallback' — que aponta pro caminho de listas paginadas. Assim o
 * mesmo fluxo atende todos os canais.
 *
 * nodeData: { body?, buttonText?, firstScreen? }
 */
@Injectable()
export class FlowNodeExecutor implements NodeExecutor {
  readonly nodeType = 'FLOW';
  private readonly logger = new Logger(FlowNodeExecutor.name);

  constructor(private readonly flowSend: FlowSendService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as Record<string, any>;
    const sentEdge = ctx.nodeEdges.find((e) => e.condition === 'sent');
    const fallbackEdge = ctx.nodeEdges.find((e) => e.condition === 'fallback');
    const sentNext = sentEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;
    const fallbackNext = fallbackEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || null;

    // Já mandamos o formulário e a pessoa respondeu (o WhatsApp devolve a
    // submissão como mensagem) → segue o fluxo em vez de reenviar.
    if (ctx.incomingMessage) {
      return { nextNodeId: sentNext, sendMessages: [], waitForInput: false };
    }

    const body =
      (d.body as string) || 'Toque abaixo para escolher unidade, especialidade e horário. 📅';
    const buttonText = (d.buttonText as string) || 'Agendar consulta';

    const plan = await this.flowSend
      .prepare(ctx.channelId, ctx.conversationId, {
        body,
        buttonText,
        firstScreen: d.firstScreen as string | undefined,
      })
      .catch((err) => {
        this.logger.warn(`Flow indisponível — fallback. ${err?.message}`);
        return null;
      });

    // Canal sem suporte a Flow → segue pelo caminho das listas.
    if (!plan) {
      return { nextNodeId: fallbackNext, sendMessages: [], waitForInput: false };
    }

    return {
      nextNodeId: sentNext,
      sendMessages: [
        {
          type: 'TEXT',
          content: {
            text: body, // fallback textual do adapter
            contentSid: plan.contentSid,
            variables: { '1': plan.flowToken },
          },
        },
      ],
      // A pessoa preenche o formulário; a resposta volta pelo webhook.
      waitForInput: true,
      updatedVariables: { flowToken: plan.flowToken },
    };
  }
}
