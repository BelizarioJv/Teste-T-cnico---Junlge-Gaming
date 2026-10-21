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
import { Wallet } from './wallet/wallet.entity.js';

export enum LedgerEntryType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export enum LedgerReferenceType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

/**
 * Lançamento contábil imutável (append-only).
 *
 * A imutabilidade é garantida no banco por um trigger que rejeita UPDATE e
 * DELETE (ver Migration20261020120000). Correções são feitas com novos
 * lançamentos compensatórios (REFUND / ROLLBACK), nunca editando o histórico.
 */
@Entity({ tableName: 'ledger_entries' })
@Unique({
  name: 'ledger_reference_unique',
  properties: ['wallet', 'referenceType', 'referenceId'],
})
@Unique({
  name: 'ledger_wallet_sequence_unique',
  properties: ['wallet', 'sequence'],
})
@Index({ name: 'ledger_entries_reference_id_index', properties: ['referenceId'] })
@Check({ name: 'ledger_entries_amount_positive', expression: 'amount > 0' })
@Check({
  name: 'ledger_entries_balance_after_non_negative',
  expression: 'balance_after >= 0',
})
@Check({ name: 'ledger_entries_sequence_positive', expression: 'sequence > 0' })
export class LedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Wallet, {
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: Wallet;

  /** Sequência contínua (1, 2, 3...) por carteira, sem lacunas. */
  @Property({ type: 'integer' })
  sequence!: number;

  @Enum(() => LedgerEntryType)
  type!: LedgerEntryType;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  /** Saldo da carteira imediatamente após este lançamento. */
  @Property({ columnType: 'numeric(20,2)' })
  balanceAfter!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Enum(() => LedgerReferenceType)
  referenceType!: LedgerReferenceType;

  /** id da WagerTransaction (ou da própria Wallet para OPENING). */
  @Property({ type: 'uuid' })
  referenceId!: string;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
