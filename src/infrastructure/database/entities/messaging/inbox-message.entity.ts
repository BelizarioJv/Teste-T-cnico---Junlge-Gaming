import {
  Entity,
  Enum,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

export enum InboxStatus {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

/**
 * Registro persistente de cada mensagem recebida da fila.
 *
 * A deduplicação acontece em duas camadas:
 * 1. `messageId` (SQS MessageId) — o SQS mantém o mesmo id em redeliveries,
 *    então a mesma mensagem nunca é processada duas vezes.
 * 2. `idempotencyKey` da WagerTransaction — cobre o produtor que reenviou a
 *    mesma operação como uma mensagem nova (MessageId diferente).
 */
@Entity({ tableName: 'inbox_messages' })
@Unique({
  name: 'inbox_source_message_unique',
  properties: ['source', 'messageId'],
})
export class InboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'varchar', length: 100 })
  source!: string;

  @Property({ type: 'varchar', length: 200 })
  messageId!: string;

  @Enum(() => InboxStatus)
  status: InboxStatus = InboxStatus.RECEIVED;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ type: 'text', nullable: true })
  lastError: string | null = null;

  /** id da WagerTransaction resultante, quando houver. */
  @Property({ type: 'uuid', nullable: true })
  transactionId: string | null = null;

  @Property({ onCreate: () => new Date() })
  receivedAt: Date = new Date();

  @Property({ nullable: true })
  processedAt: Date | null = null;
}
