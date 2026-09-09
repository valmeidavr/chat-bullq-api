import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ChannelType, ChannelSyncMode, ChannelSyncStatus, OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelsRepository } from './channels.repository';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { ZappfyHttpClient } from '../adapters/zappfy/zappfy.http-client';
import { WhatsAppOfficialHttpClient } from '../adapters/whatsapp-official/whatsapp-official.http-client';
import { InstagramHttpClient } from '../adapters/instagram/instagram.http-client';
import { GmailHttpClient } from '../adapters/gmail/gmail.http-client';
import { TwilioHttpClient } from '../adapters/twilio/twilio.http-client';
import { TwilioMenuContentService, MenuDescriptor } from '../adapters/twilio/twilio-menu-content.service';
import { EvolutionHttpClient } from '../adapters/evolution/evolution.http-client';
import { ChannelSyncOrchestrator } from '../sync/channel-sync.orchestrator';
import {
  ChannelAccessService,
  type ChannelAccess,
} from '../../iam/channel-access/channel-access.service';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly repository: ChannelsRepository,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly zappfyHttpClient: ZappfyHttpClient,
    private readonly waOfficialHttpClient: WhatsAppOfficialHttpClient,
    private readonly instagramHttpClient: InstagramHttpClient,
    private readonly gmailHttpClient: GmailHttpClient,
    private readonly twilioHttpClient: TwilioHttpClient,
    private readonly twilioMenuContent: TwilioMenuContentService,
    private readonly evolutionHttpClient: EvolutionHttpClient,
    private readonly syncOrchestrator: ChannelSyncOrchestrator,
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  // ─── Máscara de segredos ────────────────────────────────────────────────
  // O `config` do canal guarda segredos (authToken do Twilio, api keys, etc.).
  // Eles NUNCA devem sair pra o cliente em texto puro. Mascaramos nas respostas
  // ao cliente (lista + GET) e, no update, preservamos o valor salvo quando o
  // cliente reenvia a máscara (edição não sobrescreve o segredo com '••••').
  private static readonly SECRET_MASK = '••••••••';
  private static isSecretKey(k: string): boolean {
    return /token|secret|password|passphrase|private|api_?key|credential/i.test(k);
  }
  private static maskConfig(config: unknown): Record<string, any> {
    const src = (config ?? {}) as Record<string, any>;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] =
        ChannelsService.isSecretKey(k) && typeof v === 'string' && v.length > 0
          ? ChannelsService.SECRET_MASK
          : v;
    }
    return out;
  }
  private static maskChannel<T extends { config?: unknown }>(
    channel: T | null | undefined,
  ): T | null | undefined {
    if (!channel) return channel;
    return { ...channel, config: ChannelsService.maskConfig(channel.config) };
  }

  async create(
    organizationId: string,
    dto: CreateChannelDto,
    creator?: { userOrganizationId: string; role: OrgRole },
  ) {
    let channel = await this.repository.create({
      organizationId,
      type: dto.type,
      name: dto.name,
      config: dto.config,
      webhookSecret: dto.webhookSecret,
      ...(dto.visibility ? { visibility: dto.visibility } : {}),
    });

    // Deny-by-default: a brand new channel has no agents, so AGENT users in the
    // org cannot see it. The creator gets an explicit grant only if they are
    // an AGENT (OWNER/ADMIN bypass via role); admins manage other agents'
    // access via the channel-access endpoints.
    //
    // Pra canal PRIVATE, OWNER/ADMIN também precisa de grant — então se o
    // criador é um deles E o canal é PRIVATE, garantimos o grant pra evitar
    // que o criador se tranque fora do próprio canal recém-criado.
    const needsAgentGrant =
      (creator && creator.role === OrgRole.AGENT) ||
      (creator && dto.visibility === 'PRIVATE');
    if (needsAgentGrant && creator) {
      await this.prisma.channelAgent.create({
        data: {
          channelId: channel.id,
          userOrganizationId: creator.userOrganizationId,
        },
      });
    }

    // Enrich config with provider-side identifiers that the webhook router
    // needs to match incoming events. Without these, the new routing (P0-1)
    // correctly drops webhooks as "unknown locator".
    channel = (await this.enrichProviderIds(channel.id, dto.type)) ?? channel;

    // Zappfy needs its webhook configured on the provider side. Fire-and-forget.
    if (dto.type === ChannelType.WHATSAPP_ZAPPFY) {
      this.configureZappfyWebhook(channel.id).catch((err) =>
        this.logger.warn(`Zappfy webhook config failed: ${err.message}`),
      );
    }

    // WA Official needs the app explicitly subscribed to the WABA before Meta
    // starts delivering webhooks. Fire-and-forget — fails silently when the
    // token lacks `whatsapp_business_management` scope or businessAccountId
    // is missing; the user can retry via PATCH /channels/:id/test.
    if (dto.type === ChannelType.WHATSAPP_OFFICIAL) {
      this.subscribeWaOfficialApp(channel.id).catch((err) =>
        this.logger.warn(
          `WA Official subscribe failed for channel ${channel.id}: ${err.message}`,
        ),
      );
    }

    // Unified sync path — any adapter that registered a HistorySyncPort.
    if (this.adapterRegistry.hasHistorySync(dto.type)) {
      this.syncOrchestrator
        .start(channel.id, { mode: ChannelSyncMode.INITIAL })
        .catch((err) =>
          this.logger.error(
            `Auto-sync enqueue failed for channel ${channel.id}: ${err.message}`,
          ),
        );
    }

    return ChannelsService.maskChannel(channel);
  }

  /**
   * Ensures the channel's config contains the provider-side IDs used by the
   * webhook router (`igBusinessId` / `phoneNumberId`). Idempotent: skipped
   * when the IDs are already present. Runs synchronously because the webhook
   * router uses these fields and we'd rather fail channel creation than
   * silently produce an unroutable channel.
   */
  async enrichProviderIds(channelId: string, type: ChannelType) {
    try {
      const channel = await this.repository.findById(channelId);
      if (!channel) return null;
      const config = (channel.config as Record<string, any>) || {};

      if (type === ChannelType.INSTAGRAM && !config.igBusinessId) {
        const info = await this.instagramHttpClient.getMe(channel);
        const id = info?.user_id ?? info?.id;
        if (id) {
          return this.repository.update(channelId, {
            config: { ...config, igBusinessId: String(id) },
          });
        }
      }

      if (type === ChannelType.WHATSAPP_OFFICIAL && !config.phoneNumberId) {
        // phoneNumberId is part of Meta's onboarding output — if the user
        // didn't include it we can't guess, but we log loudly so it isn't silent.
        this.logger.warn(
          `WA Official channel ${channelId} created without config.phoneNumberId — webhooks will be dropped as unknown locator`,
        );
      }

      return channel;
    } catch (err: any) {
      this.logger.warn(
        `enrichProviderIds failed for channel ${channelId}: ${err.message}`,
      );
      return null;
    }
  }

  private async configureZappfyWebhook(channelId: string): Promise<void> {
    const channel = await this.repository.findById(channelId);
    if (!channel) return;
    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      this.logger.warn('APP_URL not set — skipping Zappfy webhook setup');
      return;
    }
    const webhookUrl = `${appUrl}/api/v1/webhooks/WHATSAPP_ZAPPFY`;
    await this.zappfyHttpClient.configureWebhook(channel, webhookUrl);
    this.logger.log(`Zappfy webhook configured: ${webhookUrl}`);
  }

  private async subscribeWaOfficialApp(channelId: string): Promise<void> {
    const channel = await this.repository.findById(channelId);
    if (!channel) return;
    const config = (channel.config as Record<string, any>) || {};
    if (!config.businessAccountId) {
      this.logger.warn(
        `WA Official channel ${channelId} has no businessAccountId — skipping auto-subscribe (do it manually in Meta dashboard)`,
      );
      return;
    }
    await this.waOfficialHttpClient.subscribeApp(channel);
    this.logger.log(
      `WA Official app subscribed to WABA ${config.businessAccountId} (channel ${channelId})`,
    );
  }

  async findAll(organizationId: string, access: ChannelAccess) {
    const accessibleIds = access === 'ALL' ? undefined : [...access];
    const list = await this.repository.findByOrganization(organizationId, accessibleIds);
    // Cliente nunca recebe segredo em texto puro.
    return (list as any[]).map((c) => ChannelsService.maskChannel(c));
  }

  /** Uso INTERNO (adapters, testConnection, etc.): retorna o config REAL. */
  async findOne(id: string, organizationId: string, access?: ChannelAccess) {
    const channel = await this.repository.findById(id);
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    if (access !== undefined && access !== 'ALL' && !access.has(id)) {
      throw new ForbiddenException('You do not have access to this channel');
    }
    return channel;
  }

  /** Resposta ao CLIENTE (GET /channels/:id): segredos mascarados. */
  async findOneForClient(id: string, organizationId: string, access?: ChannelAccess) {
    return ChannelsService.maskChannel(await this.findOne(id, organizationId, access));
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateChannelDto,
    callerUserOrganizationId?: string,
  ) {
    await this.findOne(id, organizationId);

    // Visibility é tratado por caminho separado pra garantir auto-grant.
    const { visibility, ...rest } = dto;
    if (visibility && callerUserOrganizationId) {
      await this.channelAccess.setChannelVisibility(
        id,
        organizationId,
        visibility,
        callerUserOrganizationId,
      );
    }

    // Preserva segredos: se o cliente reenviar a máscara ('••••••••') num campo
    // secreto do config, mantém o valor já salvo em vez de sobrescrever.
    if (rest.config && typeof rest.config === 'object') {
      const existing = await this.repository.findById(id);
      const stored = (existing?.config ?? {}) as Record<string, any>;
      const incoming = rest.config as Record<string, any>;
      const merged: Record<string, any> = { ...incoming };
      for (const [k, v] of Object.entries(incoming)) {
        if (
          ChannelsService.isSecretKey(k) &&
          (v === ChannelsService.SECRET_MASK || v === '' || v == null)
        ) {
          if (stored[k] !== undefined) merged[k] = stored[k];
          else delete merged[k];
        }
      }
      rest.config = merged;
    }

    if (Object.keys(rest).length === 0) {
      return ChannelsService.maskChannel(await this.repository.findById(id));
    }
    return ChannelsService.maskChannel(await this.repository.update(id, rest));
  }

  /**
   * Soft-deletes a channel after verifying the caller typed its exact name.
   * Messages and conversations are preserved — they are flagged `deletedAt`
   * so they stop showing in UI without destroying history.
   */
  async remove(id: string, organizationId: string, confirmName?: string) {
    const channel = await this.findOne(id, organizationId);
    if (!confirmName || confirmName.trim() !== channel.name) {
      throw new BadRequestException(
        'Confirme digitando exatamente o nome do canal para remover.',
      );
    }
    return this.repository.softDelete(id);
  }

  async findActiveByType(type: ChannelType) {
    return this.repository.findActiveByType(type);
  }

  /**
   * Resolve the channel that owns a given webhook payload by asking the
   * inbound adapter to match against `config`. Returns null when no channel
   * matches — caller MUST drop the event (and ideally log for investigation).
   */
  async resolveByLocator(
    type: ChannelType,
    matches: (channel: { config: any }) => boolean,
  ) {
    const candidates = await this.repository.findActiveByType(type);
    return candidates.find((c) => matches(c)) ?? null;
  }

  async syncChannel(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    if (!this.adapterRegistry.hasHistorySync(channel.type)) {
      return {
        success: false,
        error: `Sync not supported for channel type ${channel.type}`,
      };
    }

    const job = await this.syncOrchestrator.start(channel.id, {
      mode: ChannelSyncMode.MANUAL,
    });
    return { success: true, jobId: job.id, status: job.status };
  }

  async getSyncStatus(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    const job = await this.prisma.channelSyncJob.findFirst({
      where: { channelId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { job };
  }

  async cancelSync(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    if (this.adapterRegistry.hasHistorySync(channel.type)) {
      const job = await this.syncOrchestrator.cancel(id);
      return { job };
    }

    const active = await this.prisma.channelSyncJob.findFirst({
      where: {
        channelId: id,
        status: { in: [ChannelSyncStatus.PENDING, ChannelSyncStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) return { job: null };

    const job = await this.prisma.channelSyncJob.update({
      where: { id: active.id },
      data: { status: ChannelSyncStatus.CANCELLED, finishedAt: new Date() },
    });
    return { job };
  }

  /**
   * Templates HSM aprovados — só relevante pra WhatsApp Oficial (Cloud API),
   * onde iniciar conversa fora da janela de 24h exige template pré-aprovado
   * pela Meta. Demais canais nem têm esse conceito.
   */
  async getTemplates(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);
    if (channel.type !== ChannelType.WHATSAPP_OFFICIAL) {
      throw new BadRequestException(
        `Templates só existem para canais WhatsApp Oficial (canal é ${channel.type}).`,
      );
    }
    return this.waOfficialHttpClient.listTemplates(channel);
  }

  /**
   * Preview/sincronização do menu nativo no canal. Twilio → cria/reusa o
   * Content (quick-reply/list-picker) e devolve o status ("autorizado"/erro).
   * Outros canais → resposta indicando que será lista em texto simples.
   */
  async previewMenu(id: string, organizationId: string, menu: MenuDescriptor) {
    const channel = await this.findOne(id, organizationId);
    if (channel.type !== ChannelType.WHATSAPP_TWILIO) {
      return {
        supported: false as const,
        kind: 'text' as const,
        message: 'Este canal envia o menu como lista em texto simples.',
      };
    }
    if (!menu?.options?.length) {
      return { supported: true as const, ok: false as const, error: 'Menu sem opções.' };
    }
    if (menu.options.length > 10) {
      return {
        supported: true as const,
        ok: false as const,
        error: 'WhatsApp permite no máximo 10 itens em lista — acima disso vira texto.',
      };
    }
    try {
      const cfg = this.twilioHttpClient.cfg(channel);
      const r = await this.twilioMenuContent.ensure(
        channel.id,
        { accountSid: cfg.accountSid, authToken: cfg.authToken },
        menu,
      );
      return { supported: true as const, ok: true as const, kind: r.kind, contentSid: r.contentSid };
    } catch (e: any) {
      return {
        supported: true as const,
        ok: false as const,
        error: e?.response?.data?.message || e?.message || 'Erro ao criar o menu no Twilio.',
      };
    }
  }

  async testConnection(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    try {
      switch (channel.type) {
        case ChannelType.WHATSAPP_ZAPPFY: {
          const status = await this.zappfyHttpClient.getInstanceStatus(channel);
          const rawState = status?.state;
          const statusStr =
            typeof rawState === 'string'
              ? rawState
              : typeof rawState === 'object' && rawState?.status
                ? String(rawState.status)
                : typeof status?.status === 'string'
                  ? status.status
                  : 'connected';
          return {
            success: true,
            status: statusStr,
            data: status,
          };
        }

        case ChannelType.WHATSAPP_OFFICIAL: {
          const info = await this.waOfficialHttpClient.verifyPhoneNumber(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              phoneNumber: info.display_phone_number,
              qualityRating: info.quality_rating,
              verifiedName: info.verified_name,
            },
          };
        }

        case ChannelType.INSTAGRAM: {
          const info = await this.instagramHttpClient.getMe(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              username: info.username,
              igUserId: info.user_id || info.id,
              accountType: info.account_type,
              name: info.name,
            },
          };
        }

        case ChannelType.GMAIL: {
          // getProfile valida o refresh_token de verdade (emite access token
          // e chama a API) — se passar, o polling e o envio vão funcionar.
          const profile = await this.gmailHttpClient.getProfile(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              emailAddress: profile.emailAddress,
              messagesTotal: profile.messagesTotal,
              historyId: profile.historyId,
            },
          };
        }

        case ChannelType.WHATSAPP_TWILIO: {
          const acc = await this.twilioHttpClient.verifyAccount(channel);
          return {
            success: true,
            status: (acc?.status as string) || 'connected',
            data: { friendlyName: acc?.friendly_name, accountStatus: acc?.status },
          };
        }

        case ChannelType.WHATSAPP_EVOLUTION: {
          const st = await this.evolutionHttpClient.connectionState(channel);
          const state = st?.instance?.state || st?.state || 'connected';
          return { success: true, status: String(state), data: st };
        }

        default:
          return { success: false, error: 'Unsupported channel type' };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }
}
