import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class ChatbotFlowsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.ChatbotFlowUncheckedCreateInput) {
    return this.prisma.chatbotFlow.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.chatbotFlow.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        channels: { include: { channel: { select: { id: true, name: true, type: true } } } },
        _count: { select: { nodes: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.chatbotFlow.findFirst({
      where: { id, deletedAt: null },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        channels: { include: { channel: { select: { id: true, name: true, type: true } } } },
      },
    });
  }

  async update(id: string, data: Prisma.ChatbotFlowUpdateInput) {
    return this.prisma.chatbotFlow.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.chatbotFlow.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async replaceNodes(
    flowId: string,
    nodes: { id?: string; type: string; name?: string; positionX: number; positionY: number; data: any; edges: any }[],
  ) {
    await this.prisma.chatbotNode.deleteMany({ where: { flowId } });
    if (nodes.length === 0) return [];

    // Remapeia os ids (que vêm do editor/cliente) para novos ids persistidos e
    // reescreve os `targetNodeId` das arestas — assim as conexões sobrevivem ao
    // salvar (antes: nós recriados com id novo e arestas apontando pro id velho).
    const idMap = new Map<string, string>();
    const prepared = nodes.map((n) => {
      const newId = randomUUID();
      if (n.id) idMap.set(String(n.id), newId);
      return { ...n, newId };
    });

    return this.prisma.$transaction(
      prepared.map((n) =>
        this.prisma.chatbotNode.create({
          data: {
            id: n.newId,
            flowId,
            type: n.type as any,
            name: n.name,
            positionX: n.positionX,
            positionY: n.positionY,
            data: n.data,
            edges: Array.isArray(n.edges)
              ? n.edges.map((e: any) => ({
                  ...e,
                  targetNodeId: idMap.get(String(e.targetNodeId)) ?? e.targetNodeId,
                }))
              : n.edges,
          },
        }),
      ),
    );
  }

  async setChannels(flowId: string, channelIds: string[]) {
    await this.prisma.chatbotFlowChannel.deleteMany({ where: { flowId } });
    if (channelIds.length === 0) return;
    await this.prisma.chatbotFlowChannel.createMany({
      data: channelIds.map((channelId) => ({ flowId, channelId })),
    });
  }

  async findActiveFlowForChannel(channelId: string) {
    const link = await this.prisma.chatbotFlowChannel.findFirst({
      where: {
        channelId,
        flow: { isActive: true, deletedAt: null },
      },
      include: {
        flow: { include: { nodes: true } },
      },
    });
    return link?.flow || null;
  }
}
