import {
  Check,
  Entity,
  Enum,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

import { Wallet } from '../wallet/wallet.entity.js';

import {
  WagerOperation,
  WagerStatus,
} from '../../../../domain/wagering/wager.types.js';

// Reexportados para manter compatibilidade com imports existentes.
export { WagerOperation, WagerStatus };

/**
 * Uma operação de aposta recebida do provedor (via HTTP ou SQS).
 *
 * `idempotencyKey` é o identificador externo da transação no provedor e é
 * globalmente único. Operações derivadas (WIN, LOSS, REFUND, ROLLBACK)
 * apontam para a transação original por `referenceKey` (a idempotencyKey da
 * original). Quando a original ainda não chegou, a derivada fica em
 * PENDING_REFERENCE e é aplicada automaticamente quando a original for
 * processada.
 */
@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_idempotency_key_unique',
  properties: ['idempotencyKey'],
})
// No máximo uma liquidação (WIN/LOSS) processada por aposta.
@Unique({
  name: 'wager_single_settlement_per_target',
  expression:
    `create unique index "wager_single_settlement_per_target" on "wager_transactions" ("reference_transaction_id") ` +
    `where "operation" in ('WIN', 'LOSS') and "status" = 'PROCESSED'`,
})
// No máximo uma reversão (REFUND/ROLLBACK) processada por transação alvo.
@Unique({
  name: 'wager_single_reversal_per_target',
  expression:
    `create unique index "wager_single_reversal_per_target" on "wager_transactions" ("reference_transaction_id") ` +
    `where "operation" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED'`,
})
@Index({
  name: 'wager_pending_reference_index',
  expression:
    `create index "wager_pending_reference_index" on "wager_transactions" ("reference_key") ` +
    `where "status" = 'PENDING_REFERENCE'`,
})
@Index({ name: 'wager_transactions_wallet_id_index', properties: ['wallet'] })
@Check({ name: 'wager_transactions_amount_non_negative', expression: 'amount >= 0' })
@Check({
  name: 'wager_transactions_reference_required',
  expression: `(operation = 'BET') = (reference_key is null)`,
})
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Wallet, {
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: Wallet;

  @Property({ type: 'varchar', length: 100 })
  playerId!: string;

  @Enum(() => WagerOperation)
  operation!: WagerOperation;

  @Enum(() => WagerStatus)
  status: WagerStatus = WagerStatus.PENDING;

  @Property({ type: 'varchar', length: 200 })
  idempotencyKey!: string;

  @Property({ type: 'varchar', length: 64 })
  payloadHash!: string;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  /** idempotencyKey da transação original (obrigatório exceto em BET). */
  @Property({ type: 'varchar', length: 200, nullable: true })
  referenceKey: string | null = null;

  /** Preenchido quando a transação original é encontrada. */
  @ManyToOne(() => WagerTransaction, {
    fieldName: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
  })
  referenceTransaction: WagerTransaction | null = null;

  /** Resposta canônica devolvida em replays idempotentes. */
  @Property({ type: 'json', nullable: true })
  response: Record<string, unknown> | null = null;

  @Property({ type: 'text', nullable: true })
  failureReason: string | null = null;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
