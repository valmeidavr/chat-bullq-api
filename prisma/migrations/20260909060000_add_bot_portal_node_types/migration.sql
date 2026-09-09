-- Nós do fluxo de agendamento/mensalidades (Fase 2): OTP + ações no portal.
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'OTP_REQUEST';
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'OTP_VERIFY';
ALTER TYPE "ChatbotNodeType" ADD VALUE IF NOT EXISTS 'PORTAL_ACTION';
