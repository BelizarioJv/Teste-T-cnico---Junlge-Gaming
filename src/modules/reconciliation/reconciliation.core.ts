import { Decimal } from 'decimal.js';

/**
 * Reconciliação wallet × ledger — núcleo sem dependência de framework.
 *
 * Recebe um executor SQL genérico, então é usado igualmente pelo serviço
 * Nest (MikroORM), pelo script `bun run reconcile` e pelos testes.
 *
 * Cada lote é verificado por UMA única instrução SQL, ou seja, sobre um
 * snapshot consistente do banco: escritas concorrentes não geram falsos
 * positivos (uma carteira é lida inteira antes ou depois de um COMMIT).
 */

export type SqlExecutor = (
  sql: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>;

export enum ReconciliationIssue {
  /** wallets.balance ≠ soma assinada dos lançamentos. */
  BALANCE_MISMATCH = 'BALANCE_MISMATCH',
  /** wallets.balance ≠ balance_after do último lançamento. */
  LAST_BALANCE_AFTER_MISMATCH = 'LAST_BALANCE_AFTER_MISMATCH',
  /** Algum balance_after não confere com o saldo acumulado até ele. */
  RUNNING_BALANCE_MISMATCH = 'RUNNING_BALANCE_MISMATCH',
  /** Sequência com lacunas (quantidade ≠ maior sequência). */
  SEQUENCE_GAP = 'SEQUENCE_GAP',
  /** wallets.last_ledger_sequence ≠ maior sequência do ledger. */
  SEQUENCE_COUNTER_MISMATCH = 'SEQUENCE_COUNTER_MISMATCH',
}

export interface WalletReconciliation {
  walletId: string;
  currency: string;
  balance: string;
  ledgerBalance: string;
  /** balance − ledgerBalance */
  difference: string;
  entries: number;
  maxSequence: number;
  lastLedgerSequence: number;
  runningMismatches: number;
  issues: ReconciliationIssue[];
  consistent: boolean;
}

export interface ReconciliationSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  checkedWallets: number;
  consistentWallets: number;
  inconsistentWallets: number;
  /** Até `maxReported` carteiras inconsistentes. */
  inconsistencies: WalletReconciliation[];
  truncated: boolean;
}

const LEDGER_CTE = `
entries as (
  select l.wallet_id, l.sequence, l.balance_after,
         sum(case when l.type = 'CREDIT' then l.amount else -l.amount end)
           over (partition by l.wallet_id order by l.sequence) as running
    from ledger_entries l
    join batch b on b.id = l.wallet_id
),
agg as (
  select wallet_id,
         count(*)::int as entries,
         max(sequence)::int as max_sequence,
         (count(*) filter (where balance_after <> running))::int as running_mismatches,
         (array_agg(balance_after order by sequence desc))[1] as last_balance_after,
         (array_agg(running order by sequence desc))[1] as ledger_balance
    from entries
   group by wallet_id
)
select b.id::text as wallet_id,
       b.currency::text as currency,
       b.balance::text as balance,
       coalesce(a.ledger_balance, 0)::numeric(20,2)::text as ledger_balance,
       b.last_ledger_sequence::int as last_ledger_sequence,
       coalesce(a.entries, 0)::int as entries,
       coalesce(a.max_sequence, 0)::int as max_sequence,
       coalesce(a.running_mismatches, 0)::int as running_mismatches,
       a.last_balance_after::text as last_balance_after
  from batch b
  left join agg a on a.wallet_id = b.id
 order by b.id`;

/** Lote de carteiras por keyset (id > cursor). Parâmetros: [cursor, limit]. */
export const RECONCILE_BATCH_SQL = `
with batch as (
  select id, currency, balance, last_ledger_sequence
    from wallets
   where id > ?::uuid
   order by id
   limit ?
),${LEDGER_CTE}`;

/** Uma carteira. Parâmetros: [walletId]. */
export const RECONCILE_WALLET_SQL = `
with batch as (
  select id, currency, balance, last_ledger_sequence
    from wallets
   where id = ?::uuid
),${LEDGER_CTE}`;

const MIN_UUID = '00000000-0000-0000-0000-000000000000';

export function evaluate(row: Record<string, unknown>): WalletReconciliation {
  const balance = new Decimal(String(row.balance));
  const ledgerBalance = new Decimal(String(row.ledger_balance));
  const entries = Number(row.entries);
  const maxSequence = Number(row.max_sequence);
  const lastLedgerSequence = Number(row.last_ledger_sequence);
  const runningMismatches = Number(row.running_mismatches);
  const lastBalanceAfter =
    row.last_balance_after === null || row.last_balance_after === undefined
      ? null
      : new Decimal(String(row.last_balance_after));

  const issues: ReconciliationIssue[] = [];

  if (!balance.equals(ledgerBalance)) {
    issues.push(ReconciliationIssue.BALANCE_MISMATCH);
  }
  if (lastBalanceAfter !== null && !balance.equals(lastBalanceAfter)) {
    issues.push(ReconciliationIssue.LAST_BALANCE_AFTER_MISMATCH);
  }
  if (runningMismatches > 0) {
    issues.push(ReconciliationIssue.RUNNING_BALANCE_MISMATCH);
  }
  if (entries !== maxSequence) {
    issues.push(ReconciliationIssue.SEQUENCE_GAP);
  }
  if (lastLedgerSequence !== maxSequence) {
    issues.push(ReconciliationIssue.SEQUENCE_COUNTER_MISMATCH);
  }

  return {
    walletId: String(row.wallet_id),
    currency: String(row.currency).trim(),
    balance: balance.toFixed(2),
    ledgerBalance: ledgerBalance.toFixed(2),
    difference: balance.minus(ledgerBalance).toFixed(2),
    entries,
    maxSequence,
    lastLedgerSequence,
    runningMismatches,
    issues,
    consistent: issues.length === 0,
  };
}

export async function reconcileWallet(
  exec: SqlExecutor,
  walletId: string,
): Promise<WalletReconciliation | null> {
  const rows = await exec(RECONCILE_WALLET_SQL, [walletId]);
  return rows.length > 0 ? evaluate(rows[0]) : null;
}

export async function reconcileAll(
  exec: SqlExecutor,
  options: { batchSize?: number; maxReported?: number } = {},
): Promise<ReconciliationSummary> {
  const batchSize = options.batchSize ?? 500;
  const maxReported = options.maxReported ?? 100;
  const started = Date.now();

  let cursor = MIN_UUID;
  let checked = 0;
  let inconsistent = 0;
  const inconsistencies: WalletReconciliation[] = [];

  for (;;) {
    const rows = await exec(RECONCILE_BATCH_SQL, [cursor, batchSize]);

    for (const row of rows) {
      const result = evaluate(row);
      checked += 1;

      if (!result.consistent) {
        inconsistent += 1;
        if (inconsistencies.length < maxReported) {
          inconsistencies.push(result);
        }
      }
    }

    if (rows.length < batchSize) {
      break;
    }
    cursor = String(rows[rows.length - 1].wallet_id);
  }

  const finished = Date.now();

  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    checkedWallets: checked,
    consistentWallets: checked - inconsistent,
    inconsistentWallets: inconsistent,
    inconsistencies,
    truncated: inconsistent > inconsistencies.length,
  };
}
