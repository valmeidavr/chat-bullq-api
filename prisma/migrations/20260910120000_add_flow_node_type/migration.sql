-- Nó FLOW: envia um WhatsApp Flow (formulário nativo) quando o canal suporta;
-- senão o fluxo segue pela aresta 'fallback' (lista paginada).
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'FLOW';
