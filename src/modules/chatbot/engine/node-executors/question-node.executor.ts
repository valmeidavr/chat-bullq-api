import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';

/**
 * Nó de PERGUNTA: envia um texto e captura a resposta livre do cliente numa
 * variável. Primeira execução pergunta e espera; na volta (com incomingMessage)
 * grava a resposta e segue.
 */
@Injectable()
export class QuestionNodeExecutor implements NodeExecutor {
  readonly nodeType = 'QUESTION';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const variable = (ctx.nodeData.variable as string) || 'resposta';

    if (!ctx.incomingMessage) {
      const text = this.interpolate(
        ctx.nodeData.question || ctx.nodeData.message || 'Digite sua resposta:',
        ctx.session.variables,
      );
      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text } }],
        waitForInput: true,
      };
    }

    const answer = ctx.incomingMessage.trim();
    const nextNodeId = ctx.nodeEdges[0]?.targetNodeId || null;
    return {
      nextNodeId,
      sendMessages: [],
      waitForInput: false,
      updatedVariables: { [variable]: answer },
    };
  }

  private interpolate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] ?? `{{${k}}}`);
  }
}
