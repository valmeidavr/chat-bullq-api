import { Controller, Post, Get, Body, Res, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { WhatsAppFlowCryptoService } from './whatsapp-flow-crypto.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';

/**
 * Endpoint dos WhatsApp Flows (o Meta chama direto aqui).
 *
 * É público porque quem chama é o WhatsApp, mas NÃO é aberto: o corpo vem
 * cifrado com a nossa chave pública — sem a privada ninguém monta um pedido
 * válido. Além disso, o `flow_token` precisa existir no Redis e apontar pra uma
 * conversa com identidade já confirmada por OTP.
 *
 * A resposta é base64 em TEXTO PURO (exigência do Meta), não JSON.
 */
@ApiTags('WhatsApp Flows')
@Controller('whatsapp-flow')
export class WhatsAppFlowController {
  private readonly logger = new Logger(WhatsAppFlowController.name);

  constructor(
    private readonly crypto: WhatsAppFlowCryptoService,
    private readonly flow: WhatsAppFlowService,
  ) {}

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Diz se o endpoint de Flow está configurado' })
  health() {
    return { configured: this.crypto.isEnabled() };
  }

  @Post()
  @Public()
  @ApiOperation({ summary: 'Data exchange dos WhatsApp Flows (payload cifrado)' })
  async handle(
    @Body() body: Record<string, any>,
    @Res() res: Response,
  ): Promise<void> {
    let aesKey: Buffer;
    let iv: Buffer;
    let request: any;

    try {
      const opened = this.crypto.decryptRequest(body as any);
      request = opened.request;
      aesKey = opened.aesKey;
      iv = opened.iv;
    } catch (err: any) {
      // 421 = "minha chave não bate": o Meta recarrega a pública e tenta de novo.
      if (String(err?.message).includes('FLOW_KEY_MISMATCH')) {
        res.status(421).send();
        return;
      }
      this.logger.warn(`Flow: payload inválido — ${err?.message}`);
      res.status(HttpStatus.BAD_REQUEST).send();
      return;
    }

    const answer = await this.flow.handle(request);
    const encrypted = this.crypto.encryptResponse(answer, aesKey, iv);
    res.status(HttpStatus.OK).type('text/plain').send(encrypted);
  }
}
