import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';
import { BotOtpService } from '../../../bot-portal/bot-otp.service';
import { OtpDeliveryService } from '../../../bot-portal/otp-delivery.service';

/**
 * Nó OTP_REQUEST: lê o CPF (variável, capturado antes) + o WhatsApp de origem,
 * confere com o cadastro (portal) e, se casar, envia um código de 6 dígitos na
 * conversa. Arestas: 'success' (código enviado) / 'error' (não confere / não
 * encontrado) / 'ask_cpf' (modo phone: não identificou pelo número).
 * nodeData: { mode?: 'cpf' | 'phone', cpfVar?='cpf' }.
 */
@Injectable()
export class OtpRequestNodeExecutor implements NodeExecutor {
  readonly nodeType = 'OTP_REQUEST';
  constructor(
    private readonly otp: BotOtpService,
    private readonly delivery: OtpDeliveryService,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const d = ctx.nodeData as Record<string, any>;
    const cpf = String(ctx.session.variables[(d.cpfVar as string) || 'cpf'] ?? '');
    const successEdge = ctx.nodeEdges.find((e) => e.condition === 'success');
    const errorEdge = ctx.nodeEdges.find((e) => e.condition === 'error');
    const successNext = successEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;
    const errorNext = errorEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || successNext;

    // Já autenticado nesta conversa (30 min)? Pula a identificação e segue
    // pela aresta 'authed' (se existir), atualizando a permissão de agendar.
    const authedNext = ctx.nodeEdges.find((e) => e.condition === 'authed')?.targetNodeId;
    if (authedNext) {
      const authed = await this.otp.authedCpf(ctx.conversationId);
      if (authed) {
        const p = await this.otp.refreshPermissao(authed);
        return {
          nextNodeId: authedNext,
          sendMessages: [],
          waitForInput: false,
          updatedVariables: {
            cpfAutenticado: authed,
            otpMasked: p.masked || '',
            podeAgendar: p.podeAgendar === false ? 'nao' : 'sim',
            permissaoMotivo: p.motivo || '',
            permissaoDetalhe: p.detalhe || '',
          },
        };
      }
    }

    // Modo "phone": identifica pelo NÚMERO do WhatsApp e pede pra completar o
    // CPF (6 dígitos do meio). Não identificou (ou vários) → aresta 'ask_cpf'.
    if (d.mode === 'phone') {
      const askCpfNext = ctx.nodeEdges.find((e) => e.condition === 'ask_cpf')?.targetNodeId || errorNext;
      const r = await this.otp.startByPhone(ctx.conversationId, ctx.contactExternalId);
      if (r.ok) {
        const nome = r.nome ? `, ${r.nome}` : '';
        return {
          nextNodeId: successNext,
          sendMessages: [
            {
              type: 'TEXT',
              content: {
                text: `Encontrei seu cadastro${nome}! 🔐 Para confirmar que é você, complete seu CPF:\n\n*${r.maskedCpf}*\n\nDigite os *6 números do meio* (só os números).`,
              },
            },
          ],
          waitForInput: false,
          updatedVariables: {
            otpMasked: r.masked || '',
            otpVia: 'cpf',
            podeAgendar: r.podeAgendar === false ? 'nao' : 'sim',
            permissaoMotivo: r.motivo || '',
            permissaoDetalhe: r.detalhe || '',
          },
        };
      }
      // Sem identificação pelo número → segue pra pedir o CPF (sem mensagem).
      return { nextNodeId: askCpfNext, sendMessages: [], waitForInput: false, updatedVariables: { otpIdent: r.reason || 'nao_identificado' } };
    }

    const res = await this.otp.start(ctx.conversationId, ctx.contactExternalId, cpf);

    if (res.ok) {
      const nome = res.nome ? ` ${res.nome}` : '';
      const perm = {
        otpMasked: res.masked || '',
        podeAgendar: res.podeAgendar === false ? 'nao' : 'sim',
        permissaoMotivo: res.motivo || '',
        permissaoDetalhe: res.detalhe || '',
      };

      // Outro celular: código vai pro número CADASTRADO (prova de posse).
      if (res.viaRegistered && res.deliverTo) {
        try {
          const via = await this.delivery.sendToRegistered(ctx.channelId, res.deliverTo, res.code!);
          return {
            nextNodeId: successNext,
            sendMessages: [
              {
                type: 'TEXT',
                content: {
                  text: `Este WhatsApp não é o número cadastrado${nome}. Por segurança, enviei um código de 6 dígitos para o celular cadastrado (${res.masked || '****'}) por ${via === 'sms' ? 'SMS' : 'WhatsApp'}. 🔐\n\nDigite o código aqui para continuar.`,
                },
              },
            ],
            waitForInput: false,
            updatedVariables: { ...perm, otpVia: via },
          };
        } catch (e: any) {
          return {
            nextNodeId: errorNext,
            sendMessages: [
              {
                type: 'TEXT',
                content: {
                  text: `Este WhatsApp não é o número cadastrado${nome} e não consegui enviar o código para o celular cadastrado (${res.masked || '****'}). Ligue para (24) 2102-1909 que a secretaria te ajuda. 🙂`,
                },
              },
            ],
            waitForInput: false,
            updatedVariables: { otpError: `entrega_falhou:${e?.message || ''}` },
          };
        }
      }

      // Mesmo celular do cadastro: código na própria conversa.
      return {
        nextNodeId: successNext,
        sendMessages: [
          {
            type: 'TEXT',
            content: {
              text: `Encontrei seu cadastro${nome}! 🔐\n\nSeu código de acesso é *${res.code}*.\nDigite o código aqui para confirmar sua identidade.`,
            },
          },
        ],
        waitForInput: false,
        updatedVariables: { ...perm, otpVia: 'chat' },
      };
    }

    const msg =
      res.reason === 'rate_limit'
        ? 'Muitos códigos pedidos para esse CPF. Aguarde 1 hora ou ligue para (24) 2102-1909. 🙂'
        : res.reason === 'telefone_nao_confere'
        ? 'Não encontrei um celular cadastrado para esse CPF. Ligue para (24) 2102-1909 que a secretaria atualiza seu cadastro. 🙂'
        : res.reason === 'nao_encontrado'
          ? 'Não encontrei um cadastro ativo com esse CPF. Confira o número ou fale com a AAP-VR: (24) 2102-1909.'
          : res.reason === 'cpf_invalido'
            ? 'CPF inválido. Digite os 11 números do seu CPF.'
            : 'Não consegui validar agora. Tente novamente em instantes ou ligue (24) 2102-1909.';
    return {
      nextNodeId: errorNext,
      sendMessages: [{ type: 'TEXT', content: { text: msg } }],
      waitForInput: false,
      updatedVariables: { otpError: res.reason || 'erro' },
    };
  }
}
