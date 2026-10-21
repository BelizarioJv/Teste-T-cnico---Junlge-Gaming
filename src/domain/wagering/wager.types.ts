export enum WagerOperation {
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

/**
 * Motivos de rejeição de negócio. Uma transação rejeitada é persistida (e
 * respondida de forma idêntica em replays); não é um erro de validação.
 */
export enum RejectionReason {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  REFERENCE_NOT_PROCESSED = 'REFERENCE_NOT_PROCESSED',
  REFERENCE_WALLET_MISMATCH = 'REFERENCE_WALLET_MISMATCH',
  INVALID_REFERENCE_OPERATION = 'INVALID_REFERENCE_OPERATION',
  BET_ALREADY_SETTLED = 'BET_ALREADY_SETTLED',
  TRANSACTION_ALREADY_REVERSED = 'TRANSACTION_ALREADY_REVERSED',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
}

export const DERIVED_OPERATIONS: ReadonlySet<WagerOperation> = new Set([
  WagerOperation.WIN,
  WagerOperation.LOSS,
  WagerOperation.REFUND,
  WagerOperation.ROLLBACK,
]);

export const SETTLEMENT_OPERATIONS: readonly WagerOperation[] = [
  WagerOperation.WIN,
  WagerOperation.LOSS,
];

export const REVERSAL_OPERATIONS: readonly WagerOperation[] = [
  WagerOperation.REFUND,
  WagerOperation.ROLLBACK,
];
