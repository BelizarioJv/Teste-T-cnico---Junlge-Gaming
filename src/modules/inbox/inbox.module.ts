import { Module } from '@nestjs/common';

import { WageringModule } from '../wagering/wagering.module.js';
import { InboxService } from './inbox.service.js';
import { WagerInboxConsumer } from './wager-inbox.consumer.js';

@Module({
  imports: [WageringModule],
  providers: [InboxService, WagerInboxConsumer],
  exports: [InboxService, WagerInboxConsumer],
})
export class InboxModule {}
