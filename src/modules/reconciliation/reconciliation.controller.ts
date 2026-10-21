import { Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import type {
  ReconciliationSummary,
  WalletReconciliation,
} from './reconciliation.core.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * Endpoints operacionais. Sem autenticação nesta versão (ver
 * ARCHITECTURE.md → "Autenticação"); em produção ficariam atrás de um
 * guard administrativo ou fora da API pública.
 */
@Controller()
export class ReconciliationController {
  constructor(
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('wallets/:id/reconciliation')
  wallet(@Param('id', new ParseUUIDPipe()) id: string): Promise<WalletReconciliation> {
    return this.reconciliation.checkWallet(id);
  }

  /** Executa uma varredura completa agora e devolve o resultado. */
  @Post('reconciliation/runs')
  run(): Promise<ReconciliationSummary> {
    return this.reconciliation.runAll();
  }

  /** Último resultado do job periódico (ou da última execução manual). */
  @Get('reconciliation/last')
  last(): ReconciliationSummary | { status: 'never_run' } {
    return this.reconciliation.getLastSummary() ?? { status: 'never_run' };
  }
}
