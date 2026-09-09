-- Adiciona os tipos de nó do flow builder (pergunta, requisição HTTP, IA,
-- handoff p/ IA) ao enum. Sem isso, esses nós não podem ser persistidos.
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'QUESTION';
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'HTTP_REQUEST';
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'AI';
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'HANDOFF_AI';
