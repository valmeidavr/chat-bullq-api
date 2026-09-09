import { Injectable, Logger } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { LlmService } from '../../../ai-agents/llm/llm.service';
import { LLM_SIMPLE_MODEL } from '../../../ai-agents/llm/llm.constants';
import { LlmContent } from '../../../ai-agents/llm/llm.types';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * Nó de IA do fluxo. Dois modos (por nó):
 *   - "Responder e seguir" (conversation=false): 1 resposta, segue pra próxima
 *     aresta (comportamento clássico).
 *   - "Conversar" (conversation=true): conversa multi-turn com a IA; sai por
 *     palavra-chave (menu/voltar/sair) ou ao atingir maxTurns, aí segue a aresta.
 *
 * Quem responde: um AGENTE cadastrado (data.agentId → usa systemPrompt/model do
 * agente) e/ou um PROMPT custom (data.system + data.prompt). Travas: data.system
 * (escopo), data.refuseMessage, temperature, maxTokens.
 */
@Injectable()
export class AiNodeExecutor implements NodeExecutor {
  readonly nodeType = 'AI';
  private readonly logger = new Logger(AiNodeExecutor.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prisma: PrismaService,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as Record<string, any>;
    const vars = ctx.session.variables;
    const saveAs = (d.saveAs as string) || 'aiResponse';
    const sendAsMessage = d.sendAsMessage !== false;
    const conversation = d.conversation === true;
    const nextNodeId = ctx.nodeEdges[0]?.targetNodeId || null;

    const resolved = await this.resolveModel(d, vars);

    // ─── Modo "Responder e seguir" ───────────────────────────────────────
    if (!conversation) {
      const userText = this.interp(d.prompt || '', vars) || ctx.incomingMessage || '';
      const text = await this.ask(resolved, [{ role: 'user', content: userText }]);
      return {
        nextNodeId,
        sendMessages: sendAsMessage && text ? [{ type: 'TEXT', content: { text } }] : [],
        waitForInput: false,
        updatedVariables: { [saveAs]: text },
      };
    }

    // ─── Modo "Conversar" (multi-turn) ───────────────────────────────────
    const histKey = `_aiConv_${ctx.session.currentNodeId}`;
    const turnKey = `_aiConvTurns_${ctx.session.currentNodeId}`;
    const exitKeywords: string[] = (
      Array.isArray(d.exitKeywords) && d.exitKeywords.length
        ? d.exitKeywords
        : ['menu', 'voltar', 'sair']
    ).map((s: string) => String(s).toLowerCase());
    const maxTurns = Number(d.maxTurns) > 0 ? Number(d.maxTurns) : 10;

    // Entrada no nó (sem mensagem pendente): abre a conversa e espera.
    if (!ctx.incomingMessage) {
      const opening =
        this.interp(d.openingMessage || '', vars) ||
        'Pode falar, estou te ouvindo. 😊 (digite *menu* para voltar)';
      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: opening } }],
        waitForInput: true,
        updatedVariables: { [histKey]: [], [turnKey]: 0 },
      };
    }

    const input = ctx.incomingMessage.trim();
    // Sair da conversa → segue o fluxo pela aresta.
    if (exitKeywords.includes(input.toLowerCase())) {
      return {
        nextNodeId,
        sendMessages: [],
        waitForInput: false,
        updatedVariables: { [histKey]: [], [turnKey]: 0 },
      };
    }

    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(vars[histKey])
      ? vars[histKey]
      : [];
    const turns = Number(vars[turnKey]) || 0;

    history.push({ role: 'user', content: input });
    const text = await this.ask(resolved, history);
    history.push({ role: 'assistant', content: text });
    const newTurns = turns + 1;

    const msgs = sendAsMessage && text ? [{ type: 'TEXT', content: { text } }] : [];

    // Atingiu o limite → encerra a conversa e segue o fluxo.
    if (newTurns >= maxTurns) {
      const wrap = this.interp(d.wrapMessage || '', vars);
      if (wrap) msgs.push({ type: 'TEXT', content: { text: wrap } });
      return {
        nextNodeId,
        sendMessages: msgs,
        waitForInput: false,
        updatedVariables: { [saveAs]: text, [histKey]: [], [turnKey]: 0 },
      };
    }

    // Continua conversando.
    return {
      nextNodeId: null,
      sendMessages: msgs,
      waitForInput: true,
      updatedVariables: { [saveAs]: text, [histKey]: history.slice(-20), [turnKey]: newTurns },
    };
  }

  /** Resolve system/model/temperatura a partir do agente e/ou do prompt custom. */
  private async resolveModel(
    d: Record<string, any>,
    vars: Record<string, any>,
  ): Promise<{ system: string; modelId: string; temperature: number; refuse?: string }> {
    let system = this.interp(d.system || '', vars);
    let modelId = (d.model as string) || '';
    let temperature = typeof d.temperature === 'number' ? d.temperature : NaN;

    if (d.agentId) {
      const agent = await this.prisma.aiAgent
        .findUnique({ where: { id: String(d.agentId) } })
        .catch(() => null);
      if (agent) {
        // Base = persona/escopo do agente; o system do nó soma como trava extra.
        system = [agent.systemPrompt, system].filter((s) => s && String(s).trim()).join('\n\n');
        if (!modelId) modelId = agent.modelId;
        const mp = (agent.modelParams ?? {}) as Record<string, any>;
        if (Number.isNaN(temperature) && typeof mp.temperature === 'number') {
          temperature = mp.temperature;
        }
      }
    }

    if (!system) {
      system = 'Você é um assistente de atendimento. Responda de forma curta e útil em português.';
    }
    return {
      system,
      modelId: modelId || LLM_SIMPLE_MODEL,
      temperature: Number.isNaN(temperature) ? 0.5 : temperature,
      refuse: d.refuseMessage ? this.interp(d.refuseMessage, vars) : undefined,
    };
  }

  private async ask(
    r: { system: string; modelId: string; temperature: number; refuse?: string },
    turns: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    try {
      const res = await this.llm.complete({
        modelId: r.modelId,
        messages: [{ role: 'system', content: r.system }, ...turns],
        temperature: r.temperature,
        maxTokens: 1024,
      });
      return this.textOf(res.message.content);
    } catch (err: any) {
      this.logger.error(`AI node falhou: ${err?.message}`);
      return r.refuse || 'Desculpe, tive um problema para responder agora. Tente novamente.';
    }
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
