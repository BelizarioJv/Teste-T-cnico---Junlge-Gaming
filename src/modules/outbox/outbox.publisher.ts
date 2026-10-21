import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { LockMode, MikroORM } from '@mikro-orm/core';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { exponentialBackoffMs, sleep } from '../../common/backoff.js';
import { describeError } from '../../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import {
  OutboxEvent,
  OutboxStatus,
} from '../../infrastructure/database/entities/messaging/outbox-event.entity.js';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.module.js';
import { AppMetrics } from '../../observability/app-metrics.js';

export interface PublishStats {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}

/**
 * Publica eventos do Outbox no SQS.
 *
 * Protocolo (seguro com N instâncias e com reinício):
 * 1. CLAIM — numa transação curta, seleciona pendentes vencidos com
 *    `FOR UPDATE SKIP LOCKED`, grava um lease (`locked_until`) e incrementa
 *    `attempts`. Outras instâncias pulam essas linhas.
 * 2. PUBLISH — fora da transação (não segura lock durante I/O de rede).
 * 3. ACK — PUBLISHED em caso de sucesso; senão agenda nova tentativa com
 *    backoff exponencial, ou FAILED ao exceder `maxAttempts`.
 *
 * Se o processo morrer entre 1 e 3, o lease expira e o evento é
 * reclamado: entrega at-least-once. O id do evento vai como
 * MessageDeduplicationId para o consumidor deduplicar.
 */
@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outbox.publisherEnabled) {
      this.logger.log('Outbox publisher desabilitado (OUTBOX_PUBLISHER_ENABLED=false).');
      return;
    }

    this.logger.log({ msg: 'outbox.publisher.started', queue: this.config.sqs.eventsQueueUrl });
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  isRunning(): boolean {
    return this.loop !== null && !this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;

    while (!signal.aborted) {
      try {
        const stats = await this.publishBatch();

        // Lote cheio → provavelmente há mais; não espera.
        if (stats.claimed < this.config.outbox.batchSize) {
          await sleep(this.config.outbox.pollIntervalMs, signal);
        }
      } catch (error) {
        this.logger.error({ msg: 'outbox.batch.failed', ...describeError(error) });
        await sleep(this.config.outbox.pollIntervalMs * 5, signal);
      }
    }

    this.logger.log({ msg: 'outbox.publisher.stopped' });
  }

  /** Público para testes (e para um eventual endpoint administrativo). */
  async publishBatch(): Promise<PublishStats> {
    const events = await this.claim();
    const stats: PublishStats = { claimed: events.length, published: 0, retried: 0, failed: 0 };
    const blockedPartitions = new Set<string>();

    for (const event of events) {
      // Preserva a ordem dentro do lote: se um evento da carteira falhou,
      // os seguintes da mesma carteira esperam a próxima rodada.
      if (blockedPartitions.has(event.partitionKey)) {
        await this.release(event);
        continue;
      }

      try {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.config.sqs.eventsQueueUrl,
            MessageBody: JSON.stringify(event.payload),
            MessageGroupId: event.partitionKey,
            MessageDeduplicationId: event.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: event.eventType },
              aggregateType: { DataType: 'String', StringValue: event.aggregateType },
            },
          }),
        );

        await this.markPublished(event);
        stats.published += 1;
      } catch (error) {
        blockedPartitions.add(event.partitionKey);
        const failedForGood = await this.markRetry(event, error);
        if (failedForGood) {
          stats.failed += 1;
        } else {
          stats.retried += 1;
        }
      }
    }

    this.metrics.outboxPublish.inc({ result: 'published' }, stats.published);
    this.metrics.outboxPublish.inc({ result: 'retried' }, stats.retried);
    this.metrics.outboxPublish.inc({ result: 'failed' }, stats.failed);

    if (stats.claimed > 0) {
      this.logger.log({ msg: 'outbox.batch', ...stats });
    }

    return stats;
  }

  private async claim(): Promise<OutboxEvent[]> {
    return this.orm.em.fork().transactional(async (em) => {
      const now = new Date();
      const events = await em.find(
        OutboxEvent,
        {
          status: OutboxStatus.PENDING,
          nextAttemptAt: { $lte: now },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
        },
        {
          orderBy: { createdAt: 'asc', id: 'asc' },
          limit: this.config.outbox.batchSize,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
        },
      );

      const leaseUntil = new Date(now.getTime() + this.config.outbox.leaseMs);

      for (const event of events) {
        event.lockedUntil = leaseUntil;
        event.attempts += 1;
      }

      await em.flush();

      return events;
    });
  }

  private async markPublished(event: OutboxEvent): Promise<void> {
    await this.orm.em.fork().nativeUpdate(
      OutboxEvent,
      { id: event.id, status: OutboxStatus.PENDING },
      {
        status: OutboxStatus.PUBLISHED,
        publishedAt: new Date(),
        lockedUntil: null,
        lastError: null,
      },
    );
  }

  /** Devolve o evento sem contar tentativa (foi pulado, não falhou). */
  private async release(event: OutboxEvent): Promise<void> {
    await this.orm.em.fork().nativeUpdate(
      OutboxEvent,
      { id: event.id, status: OutboxStatus.PENDING },
      { lockedUntil: null, attempts: Math.max(0, event.attempts - 1) },
    );
  }

  private async markRetry(event: OutboxEvent, error: unknown): Promise<boolean> {
    const { code, message } = describeError(error);
    const { maxAttempts, baseBackoffMs, maxBackoffMs } = this.config.outbox;
    const exhausted = event.attempts >= maxAttempts;
    const nextAttemptAt = new Date(
      Date.now() + exponentialBackoffMs(event.attempts, baseBackoffMs, maxBackoffMs),
    );

    const em = this.orm.em.fork();

    await em.nativeUpdate(
      OutboxEvent,
      { id: event.id, status: OutboxStatus.PENDING },
      exhausted
        ? { status: OutboxStatus.FAILED, lockedUntil: null, lastError: `${code}: ${message}` }
        : { nextAttemptAt, lockedUntil: null, lastError: `${code}: ${message}` },
    );

    if (!exhausted) {
      // Segura os eventos seguintes da mesma carteira para não ultrapassarem
      // o que falhou (ordem por partição, best-effort entre instâncias).
      await em.nativeUpdate(
        OutboxEvent,
        {
          partitionKey: event.partitionKey,
          status: OutboxStatus.PENDING,
          createdAt: { $gte: event.createdAt },
          id: { $ne: event.id },
          nextAttemptAt: { $lt: nextAttemptAt },
        },
        { nextAttemptAt },
      );
    }

    const log = {
      msg: exhausted ? 'outbox.event.failed' : 'outbox.event.retry',
      eventId: event.id,
      eventType: event.eventType,
      attempts: event.attempts,
      nextAttemptAt: exhausted ? null : nextAttemptAt.toISOString(),
      code,
      message,
    };

    if (exhausted) {
      this.logger.error(log);
    } else {
      this.logger.warn(log);
    }

    return exhausted;
  }
}
