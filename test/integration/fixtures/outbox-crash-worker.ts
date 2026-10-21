/**
 * Publicador do Outbox que "trava" na chamada ao SQS: reserva (CLAIM) os
 * eventos, avisa no stdout e fica pendurado até ser morto com SIGKILL.
 * Simula um processo que morre entre o CLAIM e o ACK.
 *
 * Env: OUTBOX_LEASE_MS, OUTBOX_BATCH_SIZE.
 */
import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { ConfigModule } from '../../../src/config/config.module.js';
import config from '../../../src/infrastructure/database/mikro-orm.config.js';
import { SQS_CLIENT } from '../../../src/infrastructure/sqs/sqs.module.js';
import { OutboxModule } from '../../../src/modules/outbox/outbox.module.js';
import { OutboxPublisher } from '../../../src/modules/outbox/outbox.publisher.js';
import { ObservabilityModule } from '../../../src/observability/observability.module.js';

let announced = false;

const hangingSqs = {
  send: () => {
    if (!announced) {
      announced = true;
      process.stdout.write('CLAIMED_AND_SENDING\n');
    }
    return new Promise(() => undefined); // nunca resolve
  },
  destroy: () => undefined,
};

@Global()
@Module({
  providers: [{ provide: SQS_CLIENT, useValue: hangingSqs }],
  exports: [SQS_CLIENT],
})
class HangingSqsModule {}

@Module({
  imports: [ConfigModule, MikroOrmModule.forRoot(config), ObservabilityModule, HangingSqsModule, OutboxModule],
})
class CrashWorkerModule {}

async function main(): Promise<void> {
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(CrashWorkerModule, { logger: false });
  await app.get(OutboxPublisher).publishBatch(); // trava aqui
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
