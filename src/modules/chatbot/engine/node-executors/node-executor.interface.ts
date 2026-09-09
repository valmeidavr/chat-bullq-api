import { ChatbotSession } from '../../session/chatbot-session.types';

export interface NodeExecutionContext {
  session: ChatbotSession;
  nodeData: Record<string, any>;
  nodeEdges: { targetNodeId: string; condition?: string }[];
  incomingMessage?: string;
  conversationId: string;
  channelId: string;
  contactExternalId: string;
  /** Modo "Fluxo + IA juntos": menu aceita perguntas livres (IA de apoio). */
  aiAssist?: boolean;
}

export interface NodeExecutionResult {
  nextNodeId: string | null;
  sendMessages: { type: string; content: Record<string, any> }[];
  waitForInput: boolean;
  updatedVariables?: Record<string, any>;
  transferToHuman?: boolean;
  transferDepartmentId?: string;
  /** Entrega a conversa pra IA assumir (encerra o fluxo). */
  handoffToAi?: boolean;
  /**
   * Modo "Fluxo + IA juntos": o usuário escreveu algo que não é opção do menu.
   * O engine chama a IA de apoio com este texto, envia a resposta e re-exibe o
   * menu (em vez de "opção inválida").
   */
  aiAssistText?: string;
  /** Encerra o atendimento: limpa a sessão do fluxo (recomeça do início). */
  endSession?: boolean;
}

export interface NodeExecutor {
  readonly nodeType: string;
  execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult>;
}
