import { Migration } from '@mikro-orm/migrations';

/**
 * Endurece o núcleo financeiro e cria as tabelas de mensageria.
 *
 * - CHECKs: saldo nunca negativo, valores de ledger positivos, referência
 *   obrigatória para operações derivadas.
 * - Ledger com sequência por carteira e saldo após o lançamento
 *   (backfill dos dados existentes antes de tornar as colunas NOT NULL).
 * - Ledger imutável: trigger rejeita UPDATE, DELETE e TRUNCATE.
 * - wager_transactions: reference_key / reference_transaction_id e índices
 *   parciais garantindo uma liquidação e uma reversão por transação.
 * - inbox_messages e outbox_events.
 *
 * Totalmente reversível via down().
 */
export class Migration20261020120000 extends Migration {
  override name = 'Migration20261020120000';

  override up(): void | Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(
      `alter table "wallets" add column "last_ledger_sequence" integer not null default 0;`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_last_ledger_sequence_non_negative" check (last_ledger_sequence >= 0);`,
    );

    // --------------------------------------------------------- ledger_entries
    this.addSql(
      `alter table "ledger_entries" add column "sequence" integer null, add column "balance_after" numeric(20,2) null;`,
    );
    // Backfill determinístico para lançamentos que já existam.
    this.addSql(`
      with ordered as (
        select
          id,
          row_number() over (partition by wallet_id order by created_at, id) as seq,
          sum(case when type = 'CREDIT' then amount else -amount end)
            over (partition by wallet_id order by created_at, id
                  rows between unbounded preceding and current row) as running
        from "ledger_entries"
      )
      update "ledger_entries" le
         set "sequence" = o.seq, "balance_after" = o.running
        from ordered o
       where le.id = o.id;`);
    this.addSql(`
      update "wallets" w
         set "last_ledger_sequence" = s.max_seq
        from (select wallet_id, max("sequence") as max_seq from "ledger_entries" group by wallet_id) s
       where w.id = s.wallet_id;`);
    this.addSql(
      `alter table "ledger_entries" alter column "sequence" set not null, alter column "balance_after" set not null;`,
    );
    this.addSql(
      `alter table "ledger_entries" add constraint "ledger_wallet_sequence_unique" unique ("wallet_id", "sequence");`,
    );
    this.addSql(
      `alter table "ledger_entries" add constraint "ledger_entries_amount_positive" check (amount > 0);`,
    );
    this.addSql(
      `alter table "ledger_entries" add constraint "ledger_entries_balance_after_non_negative" check (balance_after >= 0);`,
    );
    this.addSql(
      `alter table "ledger_entries" add constraint "ledger_entries_sequence_positive" check (sequence > 0);`,
    );
    this.addSql(
      `create index "ledger_entries_reference_id_index" on "ledger_entries" ("reference_id");`,
    );

    // Ledger append-only.
    this.addSql(`
      create or replace function "ledger_entries_immutable"() returns trigger
      language plpgsql as $$
      begin
        raise exception 'ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;`);
    this.addSql(
      `create trigger "ledger_entries_no_update_delete" before update or delete on "ledger_entries" for each row execute function "ledger_entries_immutable"();`,
    );
    this.addSql(
      `create trigger "ledger_entries_no_truncate" before truncate on "ledger_entries" for each statement execute function "ledger_entries_immutable"();`,
    );

    // ----------------------------------------------------- wager_transactions
    this.addSql(
      `alter table "wager_transactions" add column "reference_key" varchar(200) null, add column "reference_transaction_id" uuid null;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_amount_non_negative" check (amount >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_required" check ((operation = 'BET') = (reference_key is null));`,
    );
    this.addSql(
      `create unique index "wager_single_settlement_per_target" on "wager_transactions" ("reference_transaction_id") where "operation" in ('WIN', 'LOSS') and "status" = 'PROCESSED';`,
    );
    this.addSql(
      `create unique index "wager_single_reversal_per_target" on "wager_transactions" ("reference_transaction_id") where "operation" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED';`,
    );
    this.addSql(
      `create index "wager_pending_reference_index" on "wager_transactions" ("reference_key") where "status" = 'PENDING_REFERENCE';`,
    );
    this.addSql(
      `create index "wager_transactions_wallet_id_index" on "wager_transactions" ("wallet_id");`,
    );

    // --------------------------------------------------------- inbox_messages
    this.addSql(`
      create table "inbox_messages" (
        "id" uuid not null,
        "source" varchar(100) not null,
        "message_id" varchar(200) not null,
        "status" text not null default 'RECEIVED',
        "payload" jsonb not null,
        "attempts" integer not null default 0,
        "last_error" text null,
        "transaction_id" uuid null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        primary key ("id")
      );`);
    this.addSql(
      `alter table "inbox_messages" add constraint "inbox_source_message_unique" unique ("source", "message_id");`,
    );
    this.addSql(
      `alter table "inbox_messages" add constraint "inbox_messages_status_check" check ("status" in ('RECEIVED', 'PROCESSED', 'FAILED'));`,
    );

    // ---------------------------------------------------------- outbox_events
    this.addSql(`
      create table "outbox_events" (
        "id" uuid not null,
        "aggregate_type" varchar(100) not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "partition_key" varchar(128) not null,
        "payload" jsonb not null,
        "status" text not null default 'PENDING',
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null,
        "locked_until" timestamptz null,
        "last_error" text null,
        "created_at" timestamptz not null,
        "published_at" timestamptz null,
        primary key ("id")
      );`);
    this.addSql(
      `alter table "outbox_events" add constraint "outbox_events_status_check" check ("status" in ('PENDING', 'PUBLISHED', 'FAILED'));`,
    );
    this.addSql(
      `create index "outbox_events_dispatch_index" on "outbox_events" ("next_attempt_at", "created_at") where "status" = 'PENDING';`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_events";`);
    this.addSql(`drop table if exists "inbox_messages";`);

    this.addSql(`drop index if exists "wager_transactions_wallet_id_index";`);
    this.addSql(`drop index if exists "wager_pending_reference_index";`);
    this.addSql(`drop index if exists "wager_single_reversal_per_target";`);
    this.addSql(`drop index if exists "wager_single_settlement_per_target";`);
    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "wager_transactions_reference_required", drop constraint if exists "wager_transactions_amount_non_negative", drop constraint if exists "wager_transactions_reference_transaction_id_foreign";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop column if exists "reference_transaction_id", drop column if exists "reference_key";`,
    );

    this.addSql(`drop trigger if exists "ledger_entries_no_truncate" on "ledger_entries";`);
    this.addSql(`drop trigger if exists "ledger_entries_no_update_delete" on "ledger_entries";`);
    this.addSql(`drop function if exists "ledger_entries_immutable"();`);
    this.addSql(`drop index if exists "ledger_entries_reference_id_index";`);
    this.addSql(
      `alter table "ledger_entries" drop constraint if exists "ledger_entries_sequence_positive", drop constraint if exists "ledger_entries_balance_after_non_negative", drop constraint if exists "ledger_entries_amount_positive", drop constraint if exists "ledger_wallet_sequence_unique";`,
    );
    this.addSql(
      `alter table "ledger_entries" drop column if exists "balance_after", drop column if exists "sequence";`,
    );

    this.addSql(
      `alter table "wallets" drop constraint if exists "wallets_last_ledger_sequence_non_negative", drop constraint if exists "wallets_balance_non_negative";`,
    );
    this.addSql(`alter table "wallets" drop column if exists "last_ledger_sequence";`);
  }
}
