import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone?: string;
}

export interface ContentApprovalStatus {
  status: string; // approved | rejected | pending | received | unsubmitted | paused | disabled
  rejectionReason?: string;
}

/**
 * Cliente da Twilio Content API (content.twilio.com/v1). Cria templates
 * (Content), submete pra aprovação de WhatsApp e consulta o status.
 * Autenticação Basic com as creds do canal (accountSid:authToken).
 */
@Injectable()
export class TwilioContentClient {
  private static readonly BASE = 'https://content.twilio.com/v1';
  private readonly logger = new Logger(TwilioContentClient.name);

  private auth(creds: TwilioCreds) {
    return { username: creds.accountSid, password: creds.authToken };
  }

  /** Monta os `types` do Content a partir do corpo + botões. */
  private buildTypes(body: string, buttons?: TemplateButton[]): Record<string, unknown> {
    if (!buttons || buttons.length === 0) {
      return { 'twilio/text': { body } };
    }
    const hasAction = buttons.some((b) => b.type === 'URL' || b.type === 'PHONE_NUMBER');
    if (hasAction) {
      return {
        'twilio/call-to-action': {
          body,
          actions: buttons.map((b) =>
            b.type === 'URL'
              ? { type: 'URL', title: b.text, url: b.url }
              : { type: 'PHONE_NUMBER', title: b.text, phone: b.phone },
          ),
        },
      };
    }
    return {
      'twilio/quick-reply': {
        body,
        actions: buttons.map((b, i) => ({ title: b.text, id: `btn_${i + 1}` })),
      },
    };
  }

  /** Conta variáveis {{1}}..{{n}} no corpo e devolve um sample map. */
  static sampleVariables(body: string): Record<string, string> {
    const nums = new Set<number>();
    for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) nums.add(Number(m[1]));
    const out: Record<string, string> = {};
    for (const n of Array.from(nums).sort((a, b) => a - b)) out[String(n)] = `valor${n}`;
    return out;
  }

  async createContent(
    creds: TwilioCreds,
    input: { name: string; language: string; body: string; buttons?: TemplateButton[] },
  ): Promise<{ sid: string }> {
    const payload = {
      friendly_name: input.name,
      language: input.language,
      variables: TwilioContentClient.sampleVariables(input.body),
      types: this.buildTypes(input.body, input.buttons),
    };
    const { data } = await axios.post(`${TwilioContentClient.BASE}/Content`, payload, {
      auth: this.auth(creds),
      timeout: 30000,
    });
    return { sid: data.sid };
  }

  /**
   * Cria um Content interativo pro nó MENU: `twilio/quick-reply` (até 3 opções,
   * vira botões) ou `twilio/list-picker` (4–10 opções, vira lista). O `id` de
   * cada opção é o `value` do menu — volta no inbound quando o usuário toca.
   * Enviável DENTRO da janela de 24h sem aprovação do WhatsApp.
   */
  async createInteractiveMenu(
    creds: TwilioCreds,
    input: {
      name: string;
      language: string;
      body: string;
      buttonText?: string;
      options: { id: string; title: string; description?: string }[];
    },
  ): Promise<{ sid: string; kind: 'quick-reply' | 'list-picker' }> {
    const kind: 'quick-reply' | 'list-picker' =
      input.options.length <= 3 ? 'quick-reply' : 'list-picker';

    const types =
      kind === 'quick-reply'
        ? {
            'twilio/quick-reply': {
              body: input.body,
              actions: input.options.slice(0, 3).map((o) => ({
                title: o.title.slice(0, 20),
                id: o.id,
              })),
            },
          }
        : {
            'twilio/list-picker': {
              body: input.body,
              button: (input.buttonText || 'Ver opções').slice(0, 20),
              items: input.options.slice(0, 10).map((o) => ({
                item: o.title.slice(0, 24),
                id: o.id,
                description: (o.description || '').slice(0, 72),
              })),
            },
          };

    const { data } = await axios.post(
      `${TwilioContentClient.BASE}/Content`,
      { friendly_name: input.name, language: input.language, variables: {}, types },
      { auth: this.auth(creds), timeout: 30000 },
    );
    return { sid: data.sid, kind };
  }

  /**
   * Template de AUTENTICAÇÃO (OTP) do WhatsApp — formato fixo do Meta (o corpo
   * é gerado por ele: "{{1}} é seu código de verificação"), com botão "copiar
   * código" e aviso de segurança. Categoria AUTHENTICATION; aprovação costuma
   * ser automática. Envio: ContentSid + ContentVariables {"1": codigo}.
   */
  async createAuthenticationTemplate(
    creds: TwilioCreds,
    input: { name: string; language: string; codeExpirationMinutes?: number },
  ): Promise<{ sid: string }> {
    const payload = {
      friendly_name: input.name,
      language: input.language,
      variables: { '1': '123456' },
      types: {
        'whatsapp/authentication': {
          add_security_recommendation: true,
          code_expiration_minutes: input.codeExpirationMinutes ?? 10,
          actions: [{ type: 'COPY_CODE', copy_code_text: 'Copiar código' }],
        },
      },
    };
    const { data } = await axios.post(`${TwilioContentClient.BASE}/Content`, payload, {
      auth: this.auth(creds),
      timeout: 30000,
    });
    return { sid: data.sid };
  }

  async submitApproval(
    creds: TwilioCreds,
    contentSid: string,
    input: { name: string; category: string },
  ): Promise<void> {
    await axios.post(
      `${TwilioContentClient.BASE}/Content/${contentSid}/ApprovalRequests/whatsapp`,
      { name: input.name, category: input.category },
      { auth: this.auth(creds), timeout: 30000 },
    );
  }

  async fetchApproval(creds: TwilioCreds, contentSid: string): Promise<ContentApprovalStatus> {
    const { data } = await axios.get(
      `${TwilioContentClient.BASE}/Content/${contentSid}/ApprovalRequests`,
      { auth: this.auth(creds), timeout: 30000 },
    );
    const wa = data?.whatsapp ?? data?.approval_requests?.whatsapp ?? {};
    return {
      status: (wa.status as string) || 'pending',
      rejectionReason: wa.rejection_reason || undefined,
    };
  }

  async deleteContent(creds: TwilioCreds, contentSid: string): Promise<void> {
    try {
      await axios.delete(`${TwilioContentClient.BASE}/Content/${contentSid}`, {
        auth: this.auth(creds),
        timeout: 30000,
      });
    } catch (err: any) {
      this.logger.warn(`deleteContent falhou (${contentSid}): ${err.message}`);
    }
  }
}
