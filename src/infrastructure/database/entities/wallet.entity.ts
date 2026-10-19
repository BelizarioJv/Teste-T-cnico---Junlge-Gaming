import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallet_player_currency_unique',
  properties: ['playerId', 'currency'],
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

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
