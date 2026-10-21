import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule, ObserveInstrument } from './app.module.js';
import { loadAppConfig } from './config/app-config.js';
import { configureApp, createLogger } from './observability/configure-app.js';

async function bootstrap() {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    // Logs emitidos durante o bootstrap saem já no formato estruturado.
    bufferLogs: true,
  });

  app.useLogger(createLogger(config));
  configureApp(app);

  // Garante que consumidor SQS e publicador do Outbox terminem o trabalho
  // em andamento antes de fechar o pool do banco (SIGTERM/SIGINT).
  app.enableShutdownHooks();

  await app.listen(config.port);

  new Logger('Bootstrap').log({
    msg: 'app.started',
    port: config.port,
    sqsConsumer: config.sqs.consumerEnabled,
    outboxPublisher: config.outbox.publisherEnabled,
    reconciliationIntervalMs: config.reconciliation.intervalMs,
  });
}
await bootstrap();
