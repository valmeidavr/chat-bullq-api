import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { OrgRole, Prisma } from '@prisma/client';
import { OrganizationsRepository } from './organizations.repository';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(private readonly repository: OrganizationsRepository) {}

  async getOrganization(orgId: string) {
    const org = await this.repository.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async updateOrganization(orgId: string, dto: UpdateOrganizationDto) {
    const current = await this.getOrganization(orgId);
    const {
      aiBusinessHours,
      watchdogBusinessHours,
      watchdogConfig,
      allowedUrlDomains,
      primaryColor,
      ...rest
    } = dto;
    // White-label: a cor da marca não tem coluna própria — mora em
    // settings.branding.primaryColor (JSON), mesclado sem perder o resto.
    const settingsUpdate =
      primaryColor !== undefined
        ? (() => {
            const settings =
              (current.settings as Record<string, unknown> | null) ?? {};
            const branding = {
              ...((settings.branding as Record<string, unknown>) ?? {}),
              primaryColor,
            };
            return {
              settings: { ...settings, branding } as Prisma.InputJsonValue,
            };
          })()
        : {};
    return this.repository.update(orgId, {
      ...rest,
      ...settingsUpdate,
      ...(aiBusinessHours !== undefined
        ? { aiBusinessHours: aiBusinessHours as object }
        : {}),
      ...(watchdogBusinessHours !== undefined
        ? { watchdogBusinessHours: watchdogBusinessHours as object }
        : {}),
      ...(watchdogConfig !== undefined
        ? { watchdogConfig: watchdogConfig as object }
        : {}),
      ...(allowedUrlDomains !== undefined
        ? {
            allowedUrlDomains:
              allowedUrlDomains === null
                ? Prisma.JsonNull
                : (allowedUrlDomains as Prisma.InputJsonValue),
          }
        : {}),
    });
  }

  async getMembers(orgId: string) {
    return this.repository.findMembers(orgId);
  }

  async inviteMember(orgId: string, dto: InviteMemberDto, inviterId: string) {
    // Check if user already exists and is already a member
    const existingUser = await this.repository.findUserByEmail(dto.email);
    if (existingUser) {
      const existingMembership = await this.repository.findMembership(existingUser.id, orgId);
      if (existingMembership) {
        throw new ConflictException('User is already a member of this organization');
      }
    }

    // Create invitation (works for both existing and non-existing users)
    const invitation = await this.repository.createInvitation(orgId, dto.email, dto.role, inviterId);
    this.logger.log(`Invitation sent to ${dto.email} for org ${orgId} by ${inviterId}`);

    // If user already exists, auto-accept: add them to org immediately
    if (existingUser) {
      await this.repository.addMember(orgId, existingUser.id, dto.role);
      await this.repository.acceptInvitation(invitation.id);
      this.logger.log(`User ${dto.email} auto-added to org ${orgId} (already registered)`);
      return { ...invitation, status: 'ACCEPTED' as const, autoAccepted: true };
    }

    return { ...invitation, autoAccepted: false };
  }

  async validateInvitation(token: string) {
    const invitation = await this.repository.findInvitationByToken(token);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    return {
      email: invitation.email,
      role: invitation.role,
      organization: invitation.organization,
    };
  }

  async getInvitations(orgId: string) {
    return this.repository.findInvitationsByOrg(orgId);
  }

  async revokeInvitation(orgId: string, invitationId: string) {
    const invitations = await this.repository.findInvitationsByOrg(orgId);
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found in this organization');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Only pending invitations can be revoked');
    }
    return this.repository.revokeInvitation(invitationId);
  }

  async updateMemberRole(orgId: string, memberId: string, dto: UpdateMemberRoleDto, actorRole: OrgRole) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER' && dto.role !== 'OWNER') {
      throw new ForbiddenException('Cannot change the role of the organization owner');
    }

    if (actorRole === 'ADMIN' && dto.role === 'OWNER') {
      throw new ForbiddenException('Only owners can assign the owner role');
    }

    return this.repository.updateMemberRole(membership.id, dto.role);
  }

  async removeMember(orgId: string, memberId: string, actorId: string) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER') {
      throw new ForbiddenException('Cannot remove the organization owner');
    }

    if (memberId === actorId) {
      throw new BadRequestException('Cannot remove yourself. Transfer ownership first.');
    }

    await this.repository.removeMember(membership.id);
    this.logger.log(`Member ${memberId} removed from org ${orgId} by ${actorId}`);
  }
}
