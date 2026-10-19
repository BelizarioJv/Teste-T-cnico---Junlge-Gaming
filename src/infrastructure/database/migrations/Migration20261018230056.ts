import { Migration } from '@mikro-orm/migrations';

export class Migration20261018230056 extends Migration {

  override name = 'Migration20261018230056';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(100) not null, "currency" char(3) not null, "balance" numeric(20,2) not null default '0.00', "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallet_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "type" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "reference_type" text not null, "reference_id" uuid not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_reference_unique" unique ("wallet_id", "reference_type", "reference_id");`);

    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_type_check" check ("type" in ('CREDIT', 'DEBIT'));`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_reference_type_check" check ("reference_type" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "ledger_entries" drop constraint "ledger_entries_wallet_id_foreign";`);

    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "ledger_entries" cascade;`);
  }

}
