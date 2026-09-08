import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { TwilioContentClient } from './twilio-content.client';

@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, TwilioContentClient],
  exports: [TemplatesService],
})
export class TemplatesModule {}
