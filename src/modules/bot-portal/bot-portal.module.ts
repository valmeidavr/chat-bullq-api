import { Module } from '@nestjs/common';
import { BotPortalClient } from './bot-portal.client';
import { BotOtpService } from './bot-otp.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { TwilioModule } from '../channel-hub/adapters/twilio/twilio.module';

/**
 * Integração com o portal do associado (Fase 2): cliente dos endpoints
 * `/api/bot/*` (regras idênticas às do site) + OTP por conversa (Redis) +
 * entrega do código no celular cadastrado (Twilio).
 */
@Module({
  imports: [TwilioModule],
  providers: [BotPortalClient, BotOtpService, OtpDeliveryService],
  exports: [BotPortalClient, BotOtpService, OtpDeliveryService],
})
export class BotPortalModule {}
