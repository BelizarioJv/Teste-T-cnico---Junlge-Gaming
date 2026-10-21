import { type BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

import { describeError } from '../../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { ApplicationOrm } from '../../infrastructure/database/orm.types.js';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.module.js';
import { WagerInboxConsumer } from '../inbox/wager-inbox.consumer.js';
import { OutboxPublisher } from '../outbox/outbox.publisher.js';

export interface CheckResult {
  status: 'ok' | 'error' | 'skipped';
  latencyMs?: number;
  detail?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: Record<string, CheckResult>;
}

const REQUIRED_TABLES = [
  'wallets',
  'ledger_entries',
  'wager_transactions',
  'inbox_messages',
  'outbox_events',
];

/**
 * - live: o processo está de pé e o event loop responde. Não toca em
 *   dependências — se falhar, o orquestrador deve reiniciar o processo.
 * - ready: o processo pode receber tráfego: banco acessível, schema
 *   migrado, SQS acessível (se algum worker estiver ligado), workers
 *   rodando e sem shutdown em andamento. Se falhar, o orquestrador apenas
 *   tira a instância do balanceador.
 */
@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private draining = false;
  private schemaVerified = false;
  private readonly startedAt = Date.now();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MikroORM) private readonly orm: ApplicationOrm,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(WagerInboxConsumer) private readonly consumer: WagerInboxConsumer,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
  ) {}

  beforeApplicationShutdown(): void {
    // Sai do balanceador antes de fechar conexões.
    this.draining = true;
  }

  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  async ready(): Promise<ReadinessReport> {
    const { consumerEnabled } = this.config.sqs;
    const { publisherEnabled } = this.config.outbox;

    const [database, schema, sqs] = await Promise.all([
      this.timed(() => this.checkDatabase()),
      this.timed(() => this.checkSchema()),
      consumerEnabled || publisherEnabled
        ? this.timed(() => this.checkSqs())
        : Promise.resolve<CheckResult>({ status: 'skipped', detail: 'workers desligados' }),
    ]);

    const checks: Record<string, CheckResult> = {
      database,
      schema,
      sqs,
      sqsConsumer: worker(consumerEnabled, this.consumer.isRunning()),
      outboxPublisher: worker(publisherEnabled, this.publisher.isRunning()),
      shutdown: this.draining
        ? { status: 'error', detail: 'shutdown em andamento' }
        : { status: 'ok' },
    };

    const healthy = Object.values(checks).every((c) => c.status !== 'error');

    return { status: healthy ? 'ok' : 'error', checks };
  }

  private async checkDatabase(): Promise<void> {
    await this.orm.em.fork().getConnection().execute('select 1');
  }

  private async checkSchema(): Promise<void> {
    if (this.schemaVerified) {
      return;
    }

    const rows = (await this.orm.em
      .fork()
      .getConnection()
      .execute(
        `select table_name from information_schema.tables where table_schema = current_schema()`,
      )) as Array<{ table_name: string }>;

    const present = new Set(rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

    if (missing.length > 0) {
      throw new Error(`migrations pendentes; tabelas ausentes: ${missing.join(', ')}`);
    }

    this.schemaVerified = true;
  }

  private async checkSqs(): Promise<void> {
    const queues = [
      ...(this.config.sqs.consumerEnabled ? [this.config.sqs.wagerQueueUrl] : []),
      ...(this.config.outbox.publisherEnabled ? [this.config.sqs.eventsQueueUrl] : []),
    ];

    await Promise.all(
      queues.map((QueueUrl) =>
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
          { abortSignal: AbortSignal.timeout(this.config.health.timeoutMs) },
        ),
      ),
    );
  }

  private async timed(check: () => Promise<void>): Promise<CheckResult> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout após ${this.config.health.timeoutMs} ms`)),
            this.config.health.timeoutMs,
          );
        }),
      ]);
      return { status: 'ok', latencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        detail: describeError(error).message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function worker(enabled: boolean, running: boolean): CheckResult {
  if (!enabled) {
    return { status: 'skipped', detail: 'desligado por configuração' };
  }
  return running ? { status: 'ok' } : { status: 'error', detail: 'loop parado' };
}
