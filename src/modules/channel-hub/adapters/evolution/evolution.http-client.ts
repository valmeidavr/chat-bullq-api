import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

/**
 * Cliente HTTP da Evolution API (Baileys). Autentica via header `apikey`.
 * Envio via /message/sendText/{instance} e /message/sendMedia/{instance}.
 */
@Injectable()
export class EvolutionHttpClient {
  private readonly logger = new Logger(EvolutionHttpClient.name);

  cfg(channel: Channel): EvolutionConfig {
    return (channel.config ?? {}) as unknown as EvolutionConfig;
  }

  private client(channel: Channel): AxiosInstance {
    const { baseUrl, apiKey } = this.cfg(channel);
    return axios.create({
      baseURL: String(baseUrl || '').replace(/\/+$/, ''),
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  async post(channel: Channel, endpoint: string, body: Record<string, any>): Promise<any> {
    try {
      const { data } = await this.client(channel).post(endpoint, body);
      return data;
    } catch (error: any) {
      this.logger.error(
        `Evolution API error ${endpoint}: ${error.response?.status} ${JSON.stringify(error.response?.data) || error.message}`,
      );
      throw error;
    }
  }

  /** Estado da conexão da instância (valida baseUrl/apiKey/instance). */
  async connectionState(channel: Channel): Promise<any> {
    const { instance } = this.cfg(channel);
    const { data } = await this.client(channel).get(`/instance/connectionState/${instance}`);
    return data;
  }

  async downloadMedia(_channel: Channel, mediaUrl: string): Promise<Buffer> {
    const { data } = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(data);
  }
}
