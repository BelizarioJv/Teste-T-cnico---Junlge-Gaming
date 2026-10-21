import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from './config/config.module.js';
import config from './infrastructure/database/mikro-orm.config.js';
import { SqsModule } from './infrastructure/sqs/sqs.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module.js';
import { WageringModule } from './modules/wagering/wagering.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { ObservabilityModule } from './observability/observability.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

/**
 * Módulos de negócio + infraestrutura, sem observabilidade externa.
 * Reutilizado pelos testes de integração.
 */
export const CORE_IMPORTS = [
  ConfigModule,
  MikroOrmModule.forRoot(config),
  ObservabilityModule,
  SqsModule,
  LedgerModule,
  WalletModule,
  WageringModule,
  InboxModule,
  OutboxModule,
  ReconciliationModule,
  HealthModule,
];

@Module({
  imports: [
    ...CORE_IMPORTS,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'wagering-processor',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
