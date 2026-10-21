import {
  Controller,
  Get,
  Global,
  Header,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

import { AppMetrics } from './app-metrics.js';

const DB_GAUGES_SQL = `
select
  (select count(*) from outbox_events where status = 'PENDING')::int as outbox_pending,
  (select count(*) from outbox_events where status = 'FAILED')::int as outbox_failed,
  coalesce(extract(epoch from now() - (select min(created_at) from outbox_events where status = 'PENDING')), 0)::float8 as outbox_oldest_pending_age,
  (select count(*) from inbox_messages where status = 'FAILED')::int as inbox_failed,
  (select count(*) from wager_transactions where status = 'PENDING_REFERENCE')::int as pending_references`;

/** Atualiza, a cada scrape, os gauges que vêm do banco. */
@Injectable()
export class DatabaseGaugesCollector implements OnModuleInit {
  constructor(
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  onModuleInit(): void {
    this.metrics.registry.addCollector(() => this.collect());
  }

  async collect(): Promise<void> {
    const rows = (await this.orm.em.fork().getConnection().execute(DB_GAUGES_SQL)) as Array<
      Record<string, number>
    >;
    const row = rows[0];

    this.metrics.outboxEvents.set({ status: 'PENDING' }, Number(row.outbox_pending));
    this.metrics.outboxEvents.set({ status: 'FAILED' }, Number(row.outbox_failed));
    this.metrics.outboxOldestPendingAge.set({}, Number(row.outbox_oldest_pending_age));
    this.metrics.inboxFailed.set({}, Number(row.inbox_failed));
    this.metrics.pendingReferences.set({}, Number(row.pending_references));
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(AppMetrics) private readonly metrics: AppMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  render(): Promise<string> {
    return this.metrics.registry.render();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: AppMetrics, useFactory: () => new AppMetrics() }, DatabaseGaugesCollector],
  exports: [AppMetrics],
})
export class ObservabilityModule {}
