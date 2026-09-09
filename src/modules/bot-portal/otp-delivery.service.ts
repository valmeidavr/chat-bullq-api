import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TwilioHttpClient } from '../channel-hub/adapters/twilio/twilio.http-client';
import { WhatsAppOfficialHttpClient } from '../channel-hub/adapters/whatsapp-official/whatsapp-official.http-client';

/**
 * Entrega o código OTP no celular CADASTRADO do associado (quando ele está em
 * outro aparelho). Funciona no Twilio e no Meta oficial:
 *  - Twilio: template aprovado (`config.otpTemplateSid`) → SMS (`config.smsFromNumber`)
 *  - Meta oficial: template aprovado no WABA (`config.otpTemplateName`,
 *    `config.otpTemplateLang`='pt_BR', `config.otpTemplateAuth`=true se for
 *    categoria AUTHENTICATION com botão "copiar código")
 * Sem canal de entrega configurado → falha (o fluxo manda pra secretaria).
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioHttpClient,
    @Inject(forwardRef(() => WhatsAppOfficialHttpClient))
    private readonly waOfficial: WhatsAppOfficialHttpClient,
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
    const to = this.e164(toDigits);

    // ─── Meta oficial (Cloud API): template aprovado no WABA ───────────────
    if (channel.type === ChannelType.WHATSAPP_OFFICIAL) {
      const mcfg = (channel.config ?? {}) as Record<string, any>;
      const name = mcfg.otpTemplateName;
      if (!name) throw new Error('sem_template_meta');
      const components: Record<string, any>[] = [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
      ];
      // Templates de categoria AUTHENTICATION exigem o botão "copiar código".
      if (mcfg.otpTemplateAuth) {
        components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
      }
      await this.waOfficial.sendMessage(channel, {
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'template',
        template: { name: String(name), language: { code: String(mcfg.otpTemplateLang || 'pt_BR') }, components },
      });
      this.logger.log(`OTP enviado por WhatsApp (Meta template) p/ ***${to.slice(-4)}`);
      return 'whatsapp';
    }

    if (channel.type !== ChannelType.WHATSAPP_TWILIO) throw new Error('entrega_otp_nao_suportada_neste_canal');

    const cfg = this.twilio.cfg(channel) as Record<string, any>;

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
