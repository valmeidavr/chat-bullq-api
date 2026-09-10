import { Injectable, Logger } from '@nestjs/common';
import { ChatbotNode } from '@prisma/client';
import { ChatbotSessionService } from '../session/chatbot-session.service';
import { ChatbotFlowsRepository } from '../chatbot-flows/chatbot-flows.repository';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executors/node-executor.interface';
import { MessageNodeExecutor } from './node-executors/message-node.executor';
import { MenuNodeExecutor } from './node-executors/menu-node.executor';
import { ConditionNodeExecutor } from './node-executors/condition-node.executor';
import { WaitNodeExecutor } from './node-executors/wait-node.executor';
import { TransferNodeExecutor } from './node-executors/transfer-node.executor';
import { QuestionNodeExecutor } from './node-executors/question-node.executor';
import { HttpRequestNodeExecutor } from './node-executors/http-request-node.executor';
import { AiNodeExecutor } from './node-executors/ai-node.executor';
import { HandoffAiNodeExecutor } from './node-executors/handoff-ai-node.executor';
import { OtpRequestNodeExecutor } from './node-executors/otp-request-node.executor';
import { OtpVerifyNodeExecutor } from './node-executors/otp-verify-node.executor';
import { PortalActionNodeExecutor } from './node-executors/portal-action-node.executor';
import { FlowNodeExecutor } from './node-executors/flow-node.executor';

export interface EngineResult {
  messages: { type: string; content: Record<string, any> }[];
  transferToHuman: boolean;
  transferDepartmentId?: string;
  sessionEnded: boolean;
  /** Fluxo entregou a conversa pra IA assumir. */
  handoffToAi?: boolean;
}

@Injectable()
export class ChatbotEngineService {
  private readonly logger = new Logger(ChatbotEngineService.name);
  private readonly executors: Map<string, NodeExecutor>;

  constructor(
    private readonly sessionService: ChatbotSessionService,
    private readonly flowsRepo: ChatbotFlowsRepository,
    messageExec: MessageNodeExecutor,
    menuExec: MenuNodeExecutor,
    conditionExec: ConditionNodeExecutor,
    waitExec: WaitNodeExecutor,
    transferExec: TransferNodeExecutor,
    questionExec: QuestionNodeExecutor,
    httpExec: HttpRequestNodeExecutor,
    aiExec: AiNodeExecutor,
    handoffAiExec: HandoffAiNodeExecutor,
    otpRequestExec: OtpRequestNodeExecutor,
    otpVerifyExec: OtpVerifyNodeExecutor,
    portalActionExec: PortalActionNodeExecutor,
    flowExec: FlowNodeExecutor,
  ) {
    this.executors = new Map<string, NodeExecutor>();
    this.executors.set(messageExec.nodeType, messageExec);
    this.executors.set(menuExec.nodeType, menuExec);
    this.executors.set(conditionExec.nodeType, conditionExec);
    this.executors.set(waitExec.nodeType, waitExec);
    this.executors.set(transferExec.nodeType, transferExec);
    this.executors.set(questionExec.nodeType, questionExec);
    this.executors.set(httpExec.nodeType, httpExec);
    this.executors.set(aiExec.nodeType, aiExec);
    this.executors.set(handoffAiExec.nodeType, handoffAiExec);
    this.executors.set(otpRequestExec.nodeType, otpRequestExec);
    this.executors.set(otpVerifyExec.nodeType, otpVerifyExec);
    this.executors.set(portalActionExec.nodeType, portalActionExec);
    this.executors.set(flowExec.nodeType, flowExec);
  }

  async processMessage(
    conversationId: string,
    channelId: string,
    contactExternalId: string,
    incomingText: string,
    opts: { aiAssist?: boolean } = {},
  ): Promise<EngineResult> {
    const allMessages: EngineResult['messages'] = [];
    let transferToHuman = false;
    let transferDepartmentId: string | undefined;

    let session = await this.sessionService.get(conversationId);

    if (!session) {
      const flow = await this.flowsRepo.findActiveFlowForChannel(channelId);
      if (!flow || !flow.nodes.length) {
        return { messages: [], transferToHuman: false, sessionEnded: true };
      }

      const startNode = flow.nodes.find((n) => n.type === 'START');
      const firstNode = startNode || flow.nodes[0];
      session = await this.sessionService.create(
        conversationId,
        flow.id,
        firstNode.id,
      );

      if (firstNode.type === 'START') {
        const edges = firstNode.edges as any[];
        const nextId = edges[0]?.targetNodeId;
        if (nextId) {
          session = (await this.sessionService.update(conversationId, { currentNodeId: nextId }))!;
        }
      }
    }

    const flow = await this.flowsRepo.findById(session.flowId);
    if (!flow) {
      await this.sessionService.destroy(conversationId);
      return { messages: [], transferToHuman: false, sessionEnded: true };
    }

    if (!flow.nodes.length) {
      await this.sessionService.destroy(conversationId);
      return { messages: [], transferToHuman: false, sessionEnded: true };
    }
    const nodesMap = new Map(flow.nodes.map((n) => [n.id, n]));

    // Sessão ÓRFÃ: o fluxo foi re-salvo (ids dos nós mudam) e a sessão aponta
    // pra um nó que não existe mais. Antes isso encerrava em silêncio e ENGOLIA
    // a mensagem do cliente. Agora recomeça do START na mesma hora.
    if (!nodesMap.has(session.currentNodeId)) {
      this.logger.warn(
        `Sessão órfã em ${conversationId} (nó ${session.currentNodeId} não existe) — reiniciando do START`,
      );
      await this.sessionService.destroy(conversationId);
      const startNode = flow.nodes.find((n) => n.type === 'START') || flow.nodes[0];
      session = await this.sessionService.create(conversationId, flow.id, startNode.id);
      if (startNode.type === 'START') {
        const nextId = (startNode.edges as any[])[0]?.targetNodeId;
        if (nextId) {
          session = (await this.sessionService.update(conversationId, { currentNodeId: nextId }))!;
        }
      }
    }

    let currentNodeId: string | null = session.currentNodeId;
    let iterations = 0;
    const MAX_ITERATIONS = 20;

    // "Voltar" em submenus: se aguardamos input num MENU e o contato digitou
    // 0/voltar, desempilha o menu anterior e re-renderiza (waitingForInput=false
    // faz o executor renderizar o menu de novo, em vez de tratar como resposta).
    const BACK_CMDS = ['0', 'voltar', 'volta'];
    if (session.waitingForInput && currentNodeId) {
      const curNode = nodesMap.get(currentNodeId);
      const txt = (incomingText || '').trim().toLowerCase();
      if (
        curNode?.type === 'MENU' &&
        BACK_CMDS.includes(txt) &&
        (session.menuHistory?.length ?? 0) > 0
      ) {
        const history = [...(session.menuHistory as string[])];
        const prev = history.pop();
        if (prev && nodesMap.has(prev)) {
          session = (await this.sessionService.update(conversationId, {
            currentNodeId: prev,
            currentMenuId: prev,
            waitingForInput: false,
            menuHistory: history,
          }))!;
          currentNodeId = prev;
        }
      }
    }

    while (currentNodeId && iterations < MAX_ITERATIONS) {
      iterations++;
      const node = nodesMap.get(currentNodeId);
      if (!node) break;

      if (node.type === 'END_FLOW') {
        await this.sessionService.destroy(conversationId);
        return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
      }

      const executor = this.executors.get(node.type);
      if (!executor) {
        this.logger.warn(`No executor for node type: ${node.type}`);
        break;
      }

      // Rastreia navegação entre menus p/ suportar "Voltar". Só na renderização
      // do menu (waitingForInput=false); ao empilhar, o executor já enxerga o
      // histórico via ctx.session e mostra a opção "0. Voltar".
      if (node.type === 'MENU' && !session.waitingForInput) {
        if (session.currentMenuId && session.currentMenuId !== node.id) {
          const history: string[] = session.menuHistory ? [...session.menuHistory] : [];
          history.push(session.currentMenuId);
          session.menuHistory = history;
        }
        session.currentMenuId = node.id;
        session = (await this.sessionService.update(conversationId, {
          currentMenuId: session.currentMenuId,
          menuHistory: session.menuHistory,
        }))!;
      }

      const ctx: NodeExecutionContext = {
        session,
        nodeData: node.data as Record<string, any>,
        nodeEdges: node.edges as any[],
        incomingMessage: session.waitingForInput ? incomingText : undefined,
        conversationId,
        channelId,
        contactExternalId,
        aiAssist: opts.aiAssist,
      };

      const result = await executor.execute(ctx);
      allMessages.push(...result.sendMessages);

      if (result.updatedVariables) {
        Object.assign(session.variables, result.updatedVariables);
      }

      // "Fluxo + IA juntos": pergunta fora do menu → IA de apoio responde e o
      // menu é re-exibido. Usa o 1º nó de IA do fluxo como config (agente/trava).
      if (result.aiAssistText) {
        const aiNode = flow.nodes.find((n) => n.type === 'AI');
        const aiExec = this.executors.get('AI');
        if (aiNode && aiExec) {
          const assist = await aiExec.execute({
            ...ctx,
            nodeData: { ...(aiNode.data as any), conversation: false, prompt: '', sendAsMessage: true },
            nodeEdges: [],
            incomingMessage: result.aiAssistText,
          });
          allMessages.push(...assist.sendMessages);
        }
        // Re-exibe o menu atual (render mode) e continua aguardando input.
        const rerender = await executor.execute({ ...ctx, incomingMessage: undefined });
        allMessages.push(...rerender.sendMessages);
        await this.sessionService.update(conversationId, {
          currentNodeId,
          waitingForInput: true,
          variables: session.variables,
        });
        return { messages: allMessages, transferToHuman: false, sessionEnded: false };
      }

      // Encerrar atendimento (opção do menu): limpa a sessão e recomeça do
      // início na próxima mensagem.
      if (result.endSession) {
        await this.sessionService.destroy(conversationId);
        return { messages: allMessages, transferToHuman: false, sessionEnded: true };
      }

      if (result.transferToHuman) {
        transferToHuman = true;
        transferDepartmentId = result.transferDepartmentId;
        await this.sessionService.destroy(conversationId);
        return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
      }

      if (result.handoffToAi) {
        await this.sessionService.destroy(conversationId);
        return {
          messages: allMessages,
          transferToHuman: false,
          sessionEnded: true,
          handoffToAi: true,
        };
      }

      if (result.waitForInput) {
        await this.sessionService.update(conversationId, {
          currentNodeId,
          waitingForInput: true,
          variables: session.variables,
        });
        return { messages: allMessages, transferToHuman: false, sessionEnded: false };
      }

      currentNodeId = result.nextNodeId;
      if (currentNodeId) {
        session = (await this.sessionService.update(conversationId, {
          currentNodeId,
          waitingForInput: false,
          variables: session.variables,
        }))!;
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      this.logger.warn(`Max iterations reached for conversation ${conversationId}`);
    }

    await this.sessionService.destroy(conversationId);
    return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
  }
}
