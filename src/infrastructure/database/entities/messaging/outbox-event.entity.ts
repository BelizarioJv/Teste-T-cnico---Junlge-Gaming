import {
  Entity,
  Enum,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

export enum OutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  /** Excedeu o número máximo de tentativas; requer intervenção manual. */
  FAILED = 'FAILED',
}

/**
 * Evento de domínio gravado na MESMA transação SQL que a mudança de estado.
 * O OutboxPublisher lê os pendentes e publica no SQS com retry/backoff.
 *
 * Entrega é at-least-once: consumidores devem deduplicar pelo `id` do evento
 * (enviado também como MessageDeduplicationId).
 */
@Entity({ tableName: 'outbox_events' })
@Index({
  name: 'outbox_events_dispatch_index',
  expression:
    `create index "outbox_events_dispatch_index" on "outbox_events" ("next_attempt_at", "created_at") ` +
    `where "status" = 'PENDING'`,
})
export class OutboxEvent {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'varchar', length: 100 })
  aggregateType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'varchar', length: 100 })
  eventType!: string;

  /** Usado como MessageGroupId (ordem por carteira na fila FIFO). */
  @Property({ type: 'varchar', length: 128 })
  partitionKey!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Enum(() => OutboxStatus)
  status: OutboxStatus = OutboxStatus.PENDING;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property()
  nextAttemptAt: Date = new Date();

  /** Lease: enquanto no futuro, o evento pertence a um publicador. */
  @Property({ nullable: true })
  lockedUntil: Date | null = null;

  @Property({ type: 'text', nullable: true })
  lastError: string | null = null;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ nullable: true })
  publishedAt: Date | null = null;
}
