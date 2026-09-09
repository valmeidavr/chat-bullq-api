import { Module } from '@nestjs/common';
import { BotPortalClient } from './bot-portal.client';
import { BotOtpService } from './bot-otp.service';

/**
 * Integração com o portal do associado (Fase 2): cliente dos endpoints
 * `/api/bot/*` (regras idênticas às do site) + OTP por conversa (Redis).
 */
@Module({
  providers: [BotPortalClient, BotOtpService],
  exports: [BotPortalClient, BotOtpService],
})
export class BotPortalModule {}
