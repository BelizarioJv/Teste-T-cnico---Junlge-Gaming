import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

/**
 * Saldo materializado da carteira.
 *
 * - `balance` nunca é alterado sem uma LedgerEntry correspondente na mesma
 *   transação SQL (ver LedgerWriter).
 * - `lastLedgerSequence` é o contador da sequência por carteira usada pelo
 *   ledger: permite paginação estável e detectar lacunas na reconciliação.
 * - Toda escrita acontece com `SELECT ... FOR UPDATE` nesta linha, o que
 *   serializa operações concorrentes sobre a mesma carteira.
 */
@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallet_player_currency_unique',
  properties: ['playerId', 'currency'],
})
@Check({ name: 'wallets_balance_non_negative', expression: 'balance >= 0' })
@Check({
  name: 'wallets_last_ledger_sequence_non_negative',
  expression: 'last_ledger_sequence >= 0',
})
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'varchar', length: 100 })
  playerId!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({
    columnType: 'numeric(20,2)',
    default: '0.00',
  })
  balance: string = '0.00';

  @Property({ type: 'integer', default: 0 })
  lastLedgerSequence: number = 0;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
