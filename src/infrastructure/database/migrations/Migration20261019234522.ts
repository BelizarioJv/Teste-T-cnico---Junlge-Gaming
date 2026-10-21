import { Migration } from '@mikro-orm/migrations';

export class Migration20261019234522 extends Migration {

  override name = 'Migration20261019234522';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid not null, "player_id" varchar(100) not null, "operation" text not null, "status" text not null default 'PENDING', "idempotency_key" varchar(200) not null, "payload_hash" varchar(64) not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "response" jsonb null, "failure_reason" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_idempotency_key_unique" unique ("idempotency_key");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_operation_check" check ("operation" in ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
