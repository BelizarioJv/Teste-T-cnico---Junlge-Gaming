/**
 * Reconciliação wallet × ledger pela linha de comando.
 *
 *   bun run reconcile            # varre todas as carteiras
 *   bun run reconcile <walletId> # uma carteira
 *
 * Saída em JSON. Exit code 1 se houver qualquer divergência (útil em CI/cron).
 */
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config.js';
import {
  reconcileAll,
  reconcileWallet,
  type SqlExecutor,
} from '../src/modules/reconciliation/reconciliation.core.js';

async function main(): Promise<number> {
  const orm = await MikroORM.init(config);
  const exec: SqlExecutor = async (sql, params) =>
    (await orm.em.fork().getConnection().execute(sql, params)) as Array<
      Record<string, unknown>
    >;

  try {
    const walletId = process.argv[2];

    if (walletId) {
      const result = await reconcileWallet(exec, walletId);
      if (!result) {
        console.error(JSON.stringify({ error: 'WALLET_NOT_FOUND', walletId }));
        return 2;
      }
      console.log(JSON.stringify(result, null, 2));
      return result.consistent ? 0 : 1;
    }

    const summary = await reconcileAll(exec);
    console.log(JSON.stringify(summary, null, 2));
    return summary.inconsistentWallets === 0 ? 0 : 1;
  } finally {
    await orm.close(true);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('Falha na reconciliação:', error);
    process.exitCode = 3;
  },
);
