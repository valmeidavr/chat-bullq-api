export interface ChatbotSession {
  flowId: string;
  conversationId: string;
  currentNodeId: string;
  variables: Record<string, any>;
  waitingForInput: boolean;
  startedAt: string;
  lastActivityAt: string;
  /** Menu atualmente exibido (para navegação "Voltar"). */
  currentMenuId?: string;
  /** Pilha de menus anteriores — permite o comando "Voltar" em submenus. */
  menuHistory?: string[];
}
