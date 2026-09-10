import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createDecipheriv,
  createCipheriv,
  privateDecrypt,
  constants as cryptoConstants,
} from 'crypto';

export interface FlowRequest {
  version: string;
  action: 'INIT' | 'BACK' | 'data_exchange' | 'ping';
  screen?: string;
  data?: Record<string, any>;
  flow_token?: string;
}

/**
 * Criptografia do endpoint de WhatsApp Flows (Meta).
 *
 * Entrada: { encrypted_flow_data, encrypted_aes_key, initial_vector }
 *  1. a chave AES vem cifrada com a NOSSA pública (RSA-OAEP/SHA-256) → abrimos
 *     com a privada (env WHATSAPP_FLOW_PRIVATE_KEY_B64);
 *  2. o corpo vem em AES-GCM, com a tag de 16 bytes no fim do buffer.
 * Saída: mesmo AES, mas com o IV com TODOS OS BITS INVERTIDOS (regra do Meta),
 * devolvido como base64 em texto puro (não é JSON).
 */
@Injectable()
export class WhatsAppFlowCryptoService {
  private readonly logger = new Logger(WhatsAppFlowCryptoService.name);
  private readonly privateKey: string | null;
  private readonly TAG_LENGTH = 16;

  constructor(config: ConfigService) {
    const b64 = config.get<string>('WHATSAPP_FLOW_PRIVATE_KEY_B64');
    const raw = config.get<string>('WHATSAPP_FLOW_PRIVATE_KEY');
    this.privateKey = b64
      ? Buffer.from(b64, 'base64').toString('utf-8')
      : raw
        ? raw.replace(/\\n/g, '\n')
        : null;
    if (!this.privateKey) {
      this.logger.warn('WHATSAPP_FLOW_PRIVATE_KEY_B64 ausente — endpoint de Flow desabilitado.');
    }
  }

  isEnabled(): boolean {
    return !!this.privateKey;
  }

  /** Abre o envelope e devolve o pedido + o material pra cifrar a resposta. */
  decryptRequest(body: {
    encrypted_flow_data?: string;
    encrypted_aes_key?: string;
    initial_vector?: string;
  }): { request: FlowRequest; aesKey: Buffer; iv: Buffer } {
    if (!this.privateKey) throw new BadRequestException('Flow endpoint não configurado.');
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body || {};
    if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
      throw new BadRequestException('Payload de Flow inválido.');
    }

    // 1) chave AES (cifrada com a nossa pública)
    let aesKey: Buffer;
    try {
      aesKey = privateDecrypt(
        {
          key: this.privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(encrypted_aes_key, 'base64'),
      );
    } catch (err: any) {
      // 421 diz ao Meta "minha chave mudou, recarregue a pública".
      this.logger.warn(`Falha ao abrir a chave AES do Flow: ${err?.message}`);
      throw new BadRequestException('FLOW_KEY_MISMATCH');
    }

    // 2) corpo (AES-GCM; tag de 16 bytes no fim)
    const iv = Buffer.from(initial_vector, 'base64');
    const full = Buffer.from(encrypted_flow_data, 'base64');
    const payload = full.subarray(0, full.length - this.TAG_LENGTH);
    const tag = full.subarray(full.length - this.TAG_LENGTH);

    const decipher = createDecipheriv(this.algo(aesKey), aesKey, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf-8');

    return { request: JSON.parse(json) as FlowRequest, aesKey, iv };
  }

  /** Cifra a resposta com o IV invertido e devolve base64 (texto puro). */
  encryptResponse(response: Record<string, any>, aesKey: Buffer, iv: Buffer): string {
    const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
    const cipher = createCipheriv(this.algo(aesKey), aesKey, flipped);
    return Buffer.concat([
      cipher.update(JSON.stringify(response), 'utf-8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }

  /** O Meta pode mandar chave de 128 ou 256 bits. */
  private algo(aesKey: Buffer): 'aes-128-gcm' | 'aes-256-gcm' {
    return aesKey.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm';
  }
}
