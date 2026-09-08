import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Número WhatsApp sender em E.164, ex.: +14155238886. */
  fromNumber?: string;
  /** Alternativa ao número: Messaging Service SID (MGxxxx). */
  messagingServiceSid?: string;
}

/**
 * Cliente HTTP do Twilio (REST API 2010-04-01). Autenticação Basic com
 * AccountSid:AuthToken. Envio de mensagens via Messages.json (form-urlencoded).
 */
@Injectable()
export class TwilioHttpClient {
  private static readonly BASE_URL = 'https://api.twilio.com/2010-04-01';
  private readonly logger = new Logger(TwilioHttpClient.name);

  cfg(channel: Channel): TwilioConfig {
    return (channel.config ?? {}) as unknown as TwilioConfig;
  }

  private client(channel: Channel): AxiosInstance {
    const { accountSid, authToken } = this.cfg(channel);
    return axios.create({
      baseURL: `${TwilioHttpClient.BASE_URL}/Accounts/${accountSid}`,
      auth: { username: accountSid, password: authToken },
      timeout: 30000,
    });
  }

  /** Envia uma mensagem. `params` já vem no formato de campos do Twilio. */
  async sendMessage(
    channel: Channel,
    params: Record<string, string>,
  ): Promise<any> {
    const body = new URLSearchParams(params);
    try {
      const { data } = await this.client(channel).post('/Messages.json', body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return data;
    } catch (error: any) {
      this.logger.error(
        `Twilio API error: ${error.response?.status} ${JSON.stringify(error.response?.data) || error.message}`,
      );
      throw error;
    }
  }

  /** Baixa mídia de uma URL do Twilio (exige Basic auth da conta). */
  async downloadMedia(channel: Channel, mediaUrl: string): Promise<Buffer> {
    const { accountSid, authToken } = this.cfg(channel);
    const { data } = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: { username: accountSid, password: authToken },
      timeout: 30000,
    });
    return Buffer.from(data);
  }
}
