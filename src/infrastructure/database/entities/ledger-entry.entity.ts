import {
  Entity,
  Enum,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';
import { Wallet } from './wallet.entity.js';

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

@Entity({ tableName: 'ledger_entries' })
@Unique({
  name: 'ledger_reference_unique',
  properties: ['wallet', 'referenceType', 'referenceId'],
})
export class LedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Wallet, {
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: Wallet;

  @Enum(() => LedgerEntryType)
  type!: LedgerEntryType;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Enum(() => LedgerReferenceType)
  referenceType!: LedgerReferenceType;

  @Property({ type: 'uuid' })
  referenceId!: string;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
