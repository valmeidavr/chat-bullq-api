import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { BotOtpService } from '../../../bot-portal/bot-otp.service';

/**
 * Nó OTP_VERIFY: espera o código digitado e confere. Sucesso → marca a conversa
 * autenticada e segue pela aresta 'success'; erro → 'error' (deixa tentar de
 * novo pelo desenho do fluxo). Não envia prompt (o OTP_REQUEST já pediu).
 */
@Injectable()
export class OtpVerifyNodeExecutor implements NodeExecutor {
  readonly nodeType = 'OTP_VERIFY';
  constructor(private readonly otp: BotOtpService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const successEdge = ctx.nodeEdges.find((e) => e.condition === 'success');
    const errorEdge = ctx.nodeEdges.find((e) => e.condition === 'error');
    const successNext = successEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;
    const errorNext = errorEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || null;

    // Entrada sem código ainda → aguarda o input.
    if (!ctx.incomingMessage) {
      return { nextNodeId: null, sendMessages: [], waitForInput: true };
    }

    const res = await this.otp.verify(ctx.conversationId, ctx.incomingMessage);
    if (res.ok) {
      return {
        nextNodeId: successNext,
        sendMessages: [{ type: 'TEXT', content: { text: 'Identidade confirmada! ✅' } }],
        waitForInput: false,
        updatedVariables: { cpfAutenticado: res.cpf || '' },
      };
    }

    if (res.reason === 'muitas_tentativas' || res.reason === 'expirado') {
      const msg =
        res.reason === 'expirado'
          ? (res.kind === 'cpf' ? 'A confirmação expirou. Vamos tentar de novo?' : 'O código expirou. Vamos tentar de novo?')
          : 'Muitas tentativas. Por segurança, recomece o acesso ou ligue para (24) 2102-1909.';
      return {
        nextNodeId: errorNext,
        sendMessages: [{ type: 'TEXT', content: { text: msg } }],
        waitForInput: false,
        updatedVariables: { otpError: res.reason },
      };
    }

    // Errado → pede de novo, continua aguardando neste nó.
    const again =
      res.kind === 'cpf'
        ? 'Não confere. Digite os *6 números do meio* do seu CPF (só os números):'
        : 'Código incorreto. Digite os 6 dígitos novamente:';
    return {
      nextNodeId: null,
      sendMessages: [{ type: 'TEXT', content: { text: again } }],
      waitForInput: true,
    };
  }
}
