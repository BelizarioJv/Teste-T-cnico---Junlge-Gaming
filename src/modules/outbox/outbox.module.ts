import { Module } from '@nestjs/common';

import { OutboxPublisher } from './outbox.publisher.js';

@Module({
  providers: [OutboxPublisher],
  exports: [OutboxPublisher],
})
export class OutboxModule {}
