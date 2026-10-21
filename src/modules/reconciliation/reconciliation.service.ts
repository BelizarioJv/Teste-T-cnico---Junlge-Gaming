import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

import { describeError } from '../../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { AppMetrics } from '../../observability/app-metrics.js';
import {
  reconcileAll,
  reconcileWallet,
  type ReconciliationSummary,
  type SqlExecutor,
  type WalletReconciliation,
} from './reconciliation.core.js';

export function mikroOrmExecutor(orm: MikroORM): SqlExecutor {
  return async (sql, params) =>
    (await orm.em.fork().getConnection().execute(sql, params)) as Array<
      Record<string, unknown>
    >;
}

/**
 * Compara o saldo materializado de cada carteira com o ledger.
 *
 * Roda sob demanda (endpoints) e, se `RECONCILIATION_INTERVAL_MS > 0`,
 * periodicamente. O resultado alimenta as métricas
 * `reconciliation_inconsistent_wallets` e `reconciliation_last_run_timestamp_seconds`.
 * É somente leitura; rodar em várias instâncias é seguro (apenas redundante).
 */
@Injectable()
export class ReconciliationService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ReconciliationSummary> | null = null;
  private lastSummary: ReconciliationSummary | null = null;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.reconciliation.intervalMs;

    if (interval <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      this.runAll().catch((error: unknown) =>
        this.logger.error({ msg: 'reconciliation.failed', ...describeError(error) }),
      );
    }, interval);
    this.timer.unref();

    this.logger.log({ msg: 'reconciliation.scheduled', intervalMs: interval });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.running?.catch(() => undefined);
  }

  async checkWallet(walletId: string): Promise<WalletReconciliation> {
    const result = await reconcileWallet(mikroOrmExecutor(this.orm), walletId);

    if (!result) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Carteira não encontrada.',
      });
    }

    return result;
  }

  /** Execuções simultâneas compartilham a mesma varredura. */
  runAll(): Promise<ReconciliationSummary> {
    if (!this.running) {
      this.running = this.doRunAll().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  getLastSummary(): ReconciliationSummary | null {
    return this.lastSummary;
  }

  private async doRunAll(): Promise<ReconciliationSummary> {
    const summary = await reconcileAll(mikroOrmExecutor(this.orm), {
      batchSize: this.config.reconciliation.batchSize,
    });

    this.lastSummary = summary;
    this.metrics.reconciliationInconsistent.set({}, summary.inconsistentWallets);
    this.metrics.reconciliationLastRun.set({}, Date.parse(summary.finishedAt) / 1000);

    const log = {
      msg: 'reconciliation.completed',
      checkedWallets: summary.checkedWallets,
      inconsistentWallets: summary.inconsistentWallets,
      durationMs: summary.durationMs,
      sample: summary.inconsistencies.slice(0, 5).map((w) => ({
        walletId: w.walletId,
        issues: w.issues,
        difference: w.difference,
      })),
    };

    if (summary.inconsistentWallets > 0) {
      this.logger.error(log);
    } else {
      this.logger.log(log);
    }

    return summary;
  }
}
