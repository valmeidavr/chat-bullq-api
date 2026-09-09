import { Module } from '@nestjs/common';
import { TwilioInboundAdapter } from './twilio.inbound-adapter';
import { TwilioOutboundAdapter } from './twilio.outbound-adapter';
import { TwilioMessageMapper } from './twilio.message-mapper';
import { TwilioHttpClient } from './twilio.http-client';
import { TwilioMenuContentService } from './twilio-menu-content.service';

@Module({
  providers: [
    TwilioInboundAdapter,
    TwilioOutboundAdapter,
    TwilioMessageMapper,
    TwilioHttpClient,
    TwilioMenuContentService,
  ],
  exports: [
    TwilioInboundAdapter,
    TwilioOutboundAdapter,
    TwilioHttpClient,
    TwilioMenuContentService,
  ],
})
export class TwilioModule {}
