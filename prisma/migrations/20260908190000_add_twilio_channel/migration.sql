-- Adiciona o tipo de canal WhatsApp via Twilio.
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_TWILIO';
