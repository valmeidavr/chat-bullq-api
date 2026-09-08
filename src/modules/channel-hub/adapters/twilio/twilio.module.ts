import { Module } from '@nestjs/common';
import { TwilioInboundAdapter } from './twilio.inbound-adapter';
import { TwilioOutboundAdapter } from './twilio.outbound-adapter';
import { TwilioMessageMapper } from './twilio.message-mapper';
import { TwilioHttpClient } from './twilio.http-client';

@Module({
  providers: [
    TwilioInboundAdapter,
    TwilioOutboundAdapter,
    TwilioMessageMapper,
    TwilioHttpClient,
  ],
  exports: [TwilioInboundAdapter, TwilioOutboundAdapter, TwilioHttpClient],
})
export class TwilioModule {}
