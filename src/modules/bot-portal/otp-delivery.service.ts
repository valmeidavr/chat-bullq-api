import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TwilioHttpClient } from '../channel-hub/adapters/twilio/twilio.http-client';

/**
 * Entrega o código OTP no celular CADASTRADO do associado (quando ele está em
 * outro aparelho). Ordem: template WhatsApp aprovado (`channel.config.
 * otpTemplateSid`) → SMS (`channel.config.smsFromNumber`) → falha (o fluxo
 * manda pra secretaria). Só Twilio por enquanto.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioHttpClient,
  ) {}

  private e164(digits: string): string {
    const d = String(digits).replace(/\D/g, '');
    return '+' + (d.length <= 11 ? '55' + d : d);
  }

  async sendToRegistered(
    channelId: string,
    toDigits: string,
    code: string,
  ): Promise<'whatsapp' | 'sms'> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new Error('canal_nao_encontrado');
    if (channel.type !== ChannelType.WHATSAPP_TWILIO) throw new Error('entrega_otp_so_twilio');

    const cfg = this.twilio.cfg(channel) as Record<string, any>;
    const to = this.e164(toDigits);

    if (cfg.otpTemplateSid) {
      const params: Record<string, string> = {
        To: `whatsapp:${to}`,
        ContentSid: String(cfg.otpTemplateSid),
        ContentVariables: JSON.stringify({ '1': code }),
      };
      if (cfg.messagingServiceSid) params.MessagingServiceSid = String(cfg.messagingServiceSid);
      else params.From = `whatsapp:${this.e164(String(cfg.fromNumber || ''))}`;
      await this.twilio.sendMessage(channel, params);
      this.logger.log(`OTP enviado por WhatsApp (template) p/ ***${to.slice(-4)}`);
      return 'whatsapp';
    }

    if (cfg.smsFromNumber) {
      await this.twilio.sendMessage(channel, {
        To: to,
        From: this.e164(String(cfg.smsFromNumber)),
        Body: `Seu codigo AAP-VR: ${code}. Valido por 10 min. Nao compartilhe.`,
      });
      this.logger.log(`OTP enviado por SMS p/ ***${to.slice(-4)}`);
      return 'sms';
    }

    throw new Error('sem_canal_de_entrega');
  }
}
