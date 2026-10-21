import { HttpStatus } from '@nestjs/common';

import type { MoneyProps } from '../../domain/money/money.js';
import {
  WagerOperation,
  WagerStatus,
} from '../../domain/wagering/wager.types.js';
import type { WagerTransaction } from '../../infrastructure/database/entities/wager/wager-transaction.entity.js';

export interface WagerTransactionView {
  transactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  operation: WagerOperation;
  status: WagerStatus;
  amount: MoneyProps;
  referenceKey: string | null;
  referenceTransactionId: string | null;
  /** Motivo de rejeição (null quando PROCESSED/PENDING_REFERENCE). */
  reason: string | null;
  /** Saldo da carteira no momento da decisão. */
  balance: MoneyProps | null;
  createdAt: string;
  updatedAt: string;
}

export function toWagerView(
  tx: WagerTransaction,
  balance: MoneyProps | null,
): WagerTransactionView {
  return {
    transactionId: tx.id,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.wallet.id,
    playerId: tx.playerId,
    operation: tx.operation,
    status: tx.status,
    amount: { amount: tx.amount, currency: tx.currency },
    referenceKey: tx.referenceKey,
    referenceTransactionId: tx.referenceTransaction?.id ?? null,
    reason: tx.failureReason,
    balance,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}

/** Resposta armazenada (replay) ou reconstruída a partir da entidade. */
export function storedView(tx: WagerTransaction): WagerTransactionView {
  return (tx.response as WagerTransactionView | null) ?? toWagerView(tx, null);
}

/**
 * O código HTTP é derivado do status persistido, então um replay devolve
 * exatamente o mesmo status e corpo da primeira resposta.
 */
export function httpStatusFor(status: WagerStatus): HttpStatus {
  switch (status) {
    case WagerStatus.PROCESSED:
      return HttpStatus.CREATED;
    case WagerStatus.PENDING_REFERENCE:
    case WagerStatus.PENDING:
      return HttpStatus.ACCEPTED;
    case WagerStatus.REJECTED:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerStatus.FAILED:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
