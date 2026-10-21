import { Module } from '@nestjs/common';

import { InboxModule } from '../inbox/inbox.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [InboxModule, OutboxModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
