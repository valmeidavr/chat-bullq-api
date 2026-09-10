import { Module } from '@nestjs/common';
import { WhatsAppFlowController } from './whatsapp-flow.controller';
import { WhatsAppFlowCryptoService } from './whatsapp-flow-crypto.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { BotPortalModule } from '../bot-portal/bot-portal.module';
import { FlowSendService } from './flow-send.service';
import { TwilioModule } from '../channel-hub/adapters/twilio/twilio.module';

/**
 * WhatsApp Flows: formulário nativo pro agendamento (unidade → especialidade →
 * horário numa tela só, sem paginação). As regras seguem no portal.
 */
@Module({
  imports: [BotPortalModule, TwilioModule],
  controllers: [WhatsAppFlowController],
  providers: [WhatsAppFlowCryptoService, WhatsAppFlowService, FlowSendService],
  exports: [WhatsAppFlowService, FlowSendService],
})
export class WhatsAppFlowModule {}
