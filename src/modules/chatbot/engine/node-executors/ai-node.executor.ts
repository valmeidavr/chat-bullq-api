import { Injectable, Logger } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { LlmService } from '../../../ai-agents/llm/llm.service';
import { LLM_SIMPLE_MODEL } from '../../../ai-agents/llm/llm.constants';
import { LlmContent } from '../../../ai-agents/llm/llm.types';

/**
 * Nó de IA: chama o LLM (OpenAI) com um prompt (interpolado), salva a resposta
 * numa variável e/ou envia como mensagem ao cliente.
 *
 * nodeData: {
 *   prompt, system?, model?,
 *   saveAs?         -> variável com a resposta (default aiResponse)
 *   sendAsMessage?  -> se true (default), também envia a resposta ao cliente
 * }
 */
@Injectable()
export class AiNodeExecutor implements NodeExecutor {
  readonly nodeType = 'AI';
  private readonly logger = new Logger(AiNodeExecutor.name);

  constructor(private readonly llm: LlmService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as Record<string, any>;
    const vars = ctx.session.variables;
    const saveAs = (d.saveAs as string) || 'aiResponse';
    const sendAsMessage = d.sendAsMessage !== false;
    const nextNodeId = ctx.nodeEdges[0]?.targetNodeId || null;

    const prompt = this.interp(d.prompt || '', vars);
    const system =
      this.interp(d.system || '', vars) ||
      'Você é um assistente de atendimento. Responda de forma curta e útil em português.';

    let text = '';
    try {
      const res = await this.llm.complete({
        modelId: (d.model as string) || LLM_SIMPLE_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: typeof d.temperature === 'number' ? d.temperature : 0.7,
        maxTokens: 1024,
      });
      text = this.textOf(res.message.content);
    } catch (err: any) {
      this.logger.error(`AI node falhou: ${err?.message}`);
      text = d.fallback ? this.interp(d.fallback, vars) : '';
    }

    return {
      nextNodeId,
      sendMessages: sendAsMessage && text ? [{ type: 'TEXT', content: { text } }] : [],
      waitForInput: false,
      updatedVariables: { [saveAs]: text },
    };
  }

  private textOf(content: LlmContent): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
      return content
        .map((p: any) => (p?.type === 'text' ? p.text : ''))
        .join('')
        .trim();
    return '';
  }
  private interp(t: string, vars: Record<string, any>): string {
    return String(t).replace(/\{\{(\w+)\}\}/g, (_, k) =>
      vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`,
    );
  }
}
