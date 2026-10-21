import { describe, expect, it } from 'vitest';

import {
  evaluate,
  reconcileAll,
  ReconciliationIssue,
  type SqlExecutor,
} from './reconciliation.core.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    wallet_id: 'w1',
    currency: 'BRL',
    balance: '70.00',
    ledger_balance: '70.00',
    last_ledger_sequence: 2,
    entries: 2,
    max_sequence: 2,
    running_mismatches: 0,
    last_balance_after: '70.00',
    ...overrides,
  };
}

describe('evaluate', () => {
  it('carteira consistente', () => {
    expect(evaluate(row())).toMatchObject({ consistent: true, issues: [], difference: '0.00' });
  });

  it('carteira vazia é consistente', () => {
    expect(
      evaluate(
        row({
          balance: '0',
          ledger_balance: '0',
          entries: 0,
          max_sequence: 0,
          last_ledger_sequence: 0,
          last_balance_after: null,
        }),
      ).consistent,
    ).toBe(true);
  });

  it('detecta saldo divergente com a diferença exata', () => {
    const result = evaluate(row({ balance: '75.00' }));
    expect(result.issues).toEqual([
      ReconciliationIssue.BALANCE_MISMATCH,
      ReconciliationIssue.LAST_BALANCE_AFTER_MISMATCH,
    ]);
    expect(result.difference).toBe('5.00');
  });

  it('detecta lacunas e contador divergente', () => {
    expect(evaluate(row({ max_sequence: 3, last_ledger_sequence: 3 })).issues).toEqual([
      ReconciliationIssue.SEQUENCE_GAP,
    ]);
    expect(evaluate(row({ last_ledger_sequence: 5 })).issues).toEqual([
      ReconciliationIssue.SEQUENCE_COUNTER_MISMATCH,
    ]);
  });

  it('compara decimais sem erro de ponto flutuante', () => {
    expect(evaluate(row({ balance: '0.30', ledger_balance: '0.3', last_balance_after: '0.30' })).consistent).toBe(true);
  });
});

describe('reconcileAll', () => {
  it('pagina por keyset até o fim e resume os resultados', async () => {
    const all = [
      row({ wallet_id: 'a' }),
      row({ wallet_id: 'b', balance: '1.00' }),
      row({ wallet_id: 'c' }),
      row({ wallet_id: 'd', running_mismatches: 1 }),
      row({ wallet_id: 'e' }),
    ];
    const cursors: unknown[] = [];
    const exec: SqlExecutor = async (_sql, [cursor, limit]) => {
      cursors.push(cursor);
      const start = cursor === '00000000-0000-0000-0000-000000000000' ? 0 : all.findIndex((r) => r.wallet_id === cursor) + 1;
      return all.slice(start, start + Number(limit));
    };

    const summary = await reconcileAll(exec, { batchSize: 2, maxReported: 1 });

    expect(cursors).toEqual(['00000000-0000-0000-0000-000000000000', 'b', 'd']);
    expect(summary).toMatchObject({
      checkedWallets: 5,
      consistentWallets: 3,
      inconsistentWallets: 2,
      truncated: true,
    });
    expect(summary.inconsistencies.map((w) => w.walletId)).toEqual(['b']);
  });
});
