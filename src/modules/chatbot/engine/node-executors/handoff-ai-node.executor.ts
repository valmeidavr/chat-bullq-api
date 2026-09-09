import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';

/**
 * Nó "Assumir com IA": encerra o fluxo e entrega a conversa pra IA responder
 * a partir daqui. Opcionalmente manda uma mensagem-ponte antes.
 *
 * nodeData: { message? } — texto opcional enviado antes de a IA assumir.
 */
@Injectable()
export class HandoffAiNodeExecutor implements NodeExecutor {
  readonly nodeType = 'HANDOFF_AI';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const text = this.interpolate(ctx.nodeData.message || '', ctx.session.variables);
    return {
      nextNodeId: null,
      sendMessages: text ? [{ type: 'TEXT', content: { text } }] : [],
      waitForInput: false,
      handoffToAi: true,
    };
  }

  private interpolate(t: string, vars: Record<string, any>): string {
    return String(t).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
  }
}
