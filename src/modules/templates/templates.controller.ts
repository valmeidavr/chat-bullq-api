import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';

@ApiTags('Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista templates da organização' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria template e envia pra aprovação (Twilio)' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.service.create(orgId, dto);
  }

  @Post(':id/sync')
  @ApiOperation({ summary: 'Sincroniza o status de aprovação com o provedor' })
  sync(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.syncStatus(orgId, id);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove um template' })
  remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }
}
