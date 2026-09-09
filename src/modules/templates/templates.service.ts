import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChannelType, TemplateStatus, Channel } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { TwilioContentClient, TwilioCreds } from './twilio-content.client';

function mapTwilioStatus(s: string): TemplateStatus {
  switch ((s || '').toLowerCase()) {
    case 'approved':
      return TemplateStatus.APPROVED;
    case 'rejected':
      return TemplateStatus.REJECTED;
    case 'paused':
      return TemplateStatus.PAUSED;
    case 'disabled':
      return TemplateStatus.REJECTED;
    default:
      return TemplateStatus.PENDING;
  }
}

function countVars(body: string): number {
  const nums = new Set<number>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) nums.add(Number(m[1]));
  return nums.size;
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly content: TwilioContentClient,
  ) {}

  list(orgId: string) {
    return this.prisma.messageTemplate.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  private credsFrom(channel: Channel): TwilioCreds {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    if (!cfg.accountSid || !cfg.authToken) {
      throw new BadRequestException(
        'O canal Twilio não tem Account SID / Auth Token configurados.',
      );
    }
    return { accountSid: cfg.accountSid, authToken: cfg.authToken };
  }

  private async resolveTwilioChannel(
    orgId: string,
    channelId?: string,
  ): Promise<Channel> {
    const channel = channelId
      ? await this.prisma.channel.findFirst({
          where: {
            id: channelId,
            organizationId: orgId,
            type: ChannelType.WHATSAPP_TWILIO,
            deletedAt: null,
          },
        })
      : await this.prisma.channel.findFirst({
          where: {
            organizationId: orgId,
            type: ChannelType.WHATSAPP_TWILIO,
            deletedAt: null,
          },
          orderBy: { createdAt: 'asc' },
        });
    if (!channel) {
      throw new BadRequestException(
        'Nenhum canal WhatsApp (Twilio) encontrado. Crie o canal antes de criar templates.',
      );
    }
    return channel;
  }

  async create(orgId: string, dto: CreateTemplateDto) {
    const channel = await this.resolveTwilioChannel(orgId, dto.channelId);
    const creds = this.credsFrom(channel);
    const language = dto.language || 'pt_BR';

    // 1. Persiste como DRAFT primeiro (nunca perde o trabalho do usuário).
    const template = await this.prisma.messageTemplate.create({
      data: {
        organizationId: orgId,
        channelId: channel.id,
        name: dto.name,
        language,
        category: dto.category,
        body: dto.body,
        variablesCount: countVars(dto.body),
        buttons: dto.buttons ? (dto.buttons as any) : undefined,
        provider: 'TWILIO',
        status: TemplateStatus.DRAFT,
      },
    });

    // 2. Cria o Content no Twilio + submete pra aprovação de WhatsApp.
    //    AUTHENTICATION (OTP) usa o formato fixo do Meta (corpo gerado por ele,
    //    botão "copiar código") — texto livre nessa categoria é rejeitado.
    try {
      const { sid } =
        String(dto.category).toUpperCase() === 'AUTHENTICATION'
          ? await this.content.createAuthenticationTemplate(creds, { name: dto.name, language })
          : await this.content.createContent(creds, {
              name: dto.name,
              language,
              body: dto.body,
              buttons: dto.buttons,
            });
      await this.content.submitApproval(creds, sid, {
        name: dto.name,
        category: dto.category,
      });
      return this.prisma.messageTemplate.update({
        where: { id: template.id },
        data: { providerSid: sid, status: TemplateStatus.PENDING, rejectionReason: null },
      });
    } catch (err: any) {
      const detail =
        err?.response?.data?.message || err?.message || 'erro desconhecido';
      this.logger.error(`Falha ao criar template no Twilio: ${detail}`);
      await this.prisma.messageTemplate.update({
        where: { id: template.id },
        data: { status: TemplateStatus.DRAFT, rejectionReason: `Falha no envio: ${detail}` },
      });
      throw new BadRequestException(`Falha ao enviar template pro Twilio: ${detail}`);
    }
  }

  async syncStatus(orgId: string, id: string) {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
    if (!template) throw new NotFoundException('Template não encontrado');
    if (!template.providerSid || !template.channelId) return template;

    const channel = await this.prisma.channel.findFirst({
      where: { id: template.channelId, organizationId: orgId },
    });
    if (!channel) return template;

    const approval = await this.content.fetchApproval(
      this.credsFrom(channel),
      template.providerSid,
    );
    return this.prisma.messageTemplate.update({
      where: { id: template.id },
      data: {
        status: mapTwilioStatus(approval.status),
        rejectionReason: approval.rejectionReason ?? null,
      },
    });
  }

  async remove(orgId: string, id: string) {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
    if (!template) throw new NotFoundException('Template não encontrado');

    if (template.providerSid && template.channelId) {
      const channel = await this.prisma.channel.findFirst({
        where: { id: template.channelId, organizationId: orgId },
      });
      if (channel) {
        const cfg = (channel.config ?? {}) as Record<string, any>;
        if (cfg.accountSid && cfg.authToken) {
          await this.content.deleteContent(
            { accountSid: cfg.accountSid, authToken: cfg.authToken },
            template.providerSid,
          );
        }
      }
    }
    await this.prisma.messageTemplate.update({
      where: { id: template.id },
      data: { deletedAt: new Date() },
    });
    return { deleted: true };
  }
}
