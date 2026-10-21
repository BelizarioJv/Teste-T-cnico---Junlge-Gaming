import { Money } from '../money/money.js';
import {
  DERIVED_OPERATIONS,
  RejectionReason,
  WagerOperation,
  WagerStatus,
} from './wager.types.js';

/**
 * Regras de negócio puras (sem I/O) para operações de aposta.
 *
 * O serviço de aplicação carrega o estado sob lock e delega aqui a decisão;
 * isso mantém as regras testáveis sem banco.
 */

export type BalanceEffect =
  | { kind: 'DEBIT'; amount: Money }
  | { kind: 'CREDIT'; amount: Money }
  | { kind: 'NONE' };

export type Decision =
  | { outcome: 'APPLY'; effect: BalanceEffect }
  | { outcome: 'REJECT'; reason: RejectionReason }
  /** A transação original ainda não existe ou não foi resolvida. */
  | { outcome: 'WAIT' };

/** Estado da transação original referenciada por uma operação derivada. */
export interface ReferenceTarget {
  operation: WagerOperation;
  status: WagerStatus;
  amount: Money;
  walletId: string;
  /** Já existe WIN/LOSS processado para esta aposta. */
  settled: boolean;
  /** Já existe REFUND/ROLLBACK processado para esta transação. */
  reversed: boolean;
}

export class WagerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WagerValidationError';
  }
}

/**
 * Validação estrutural do comando (erro do cliente → HTTP 400, nada é
 * persistido).
 */
export function assertCommandShape(
  operation: WagerOperation,
  amount: Money,
  referenceKey: string | null,
  idempotencyKey: string,
): void {
  if (operation === WagerOperation.BET && referenceKey !== null) {
    throw new WagerValidationError('BET não aceita referenceKey.');
  }

  if (DERIVED_OPERATIONS.has(operation) && referenceKey === null) {
    throw new WagerValidationError(`${operation} exige referenceKey.`);
  }

  if (referenceKey !== null && referenceKey === idempotencyKey) {
    throw new WagerValidationError(
      'referenceKey não pode ser igual à idempotencyKey.',
    );
  }

  if (operation === WagerOperation.LOSS) {
    if (!amount.isZero()) {
      throw new WagerValidationError('LOSS deve ter amount igual a 0.00.');
    }
    return;
  }

  if (!amount.isPositive() || amount.isZero()) {
    throw new WagerValidationError(`${operation} exige amount maior que zero.`);
  }
}

export function decideBet(amount: Money): Decision {
  return { outcome: 'APPLY', effect: { kind: 'DEBIT', amount } };
}

export function decideDerived(
  operation: WagerOperation,
  amount: Money,
  walletId: string,
  target: ReferenceTarget | null,
): Decision {
  if (target === null) {
    return { outcome: 'WAIT' };
  }

  if (target.walletId !== walletId) {
    return reject(RejectionReason.REFERENCE_WALLET_MISMATCH);
  }

  if (
    target.status === WagerStatus.PENDING ||
    target.status === WagerStatus.PENDING_REFERENCE
  ) {
    return { outcome: 'WAIT' };
  }

  if (target.status !== WagerStatus.PROCESSED) {
    return reject(RejectionReason.REFERENCE_NOT_PROCESSED);
  }

  if (target.reversed) {
    return reject(RejectionReason.TRANSACTION_ALREADY_REVERSED);
  }

  switch (operation) {
    case WagerOperation.WIN:
    case WagerOperation.LOSS: {
      if (target.operation !== WagerOperation.BET) {
        return reject(RejectionReason.INVALID_REFERENCE_OPERATION);
      }
      if (target.settled) {
        return reject(RejectionReason.BET_ALREADY_SETTLED);
      }
      return operation === WagerOperation.WIN
        ? { outcome: 'APPLY', effect: { kind: 'CREDIT', amount } }
        : { outcome: 'APPLY', effect: { kind: 'NONE' } };
    }

    case WagerOperation.REFUND: {
      if (target.operation !== WagerOperation.BET) {
        return reject(RejectionReason.INVALID_REFERENCE_OPERATION);
      }
      if (target.settled) {
        return reject(RejectionReason.BET_ALREADY_SETTLED);
      }
      if (!amount.equals(target.amount)) {
        return reject(RejectionReason.AMOUNT_MISMATCH);
      }
      return { outcome: 'APPLY', effect: { kind: 'CREDIT', amount } };
    }

    case WagerOperation.ROLLBACK: {
      if (!amount.equals(target.amount)) {
        return reject(RejectionReason.AMOUNT_MISMATCH);
      }
      if (target.operation === WagerOperation.BET) {
        // Desfazer uma aposta já liquidada exige desfazer o WIN antes.
        if (target.settled) {
          return reject(RejectionReason.BET_ALREADY_SETTLED);
        }
        return { outcome: 'APPLY', effect: { kind: 'CREDIT', amount } };
      }
      if (target.operation === WagerOperation.WIN) {
        return { outcome: 'APPLY', effect: { kind: 'DEBIT', amount } };
      }
      return reject(RejectionReason.INVALID_REFERENCE_OPERATION);
    }

    default:
      return reject(RejectionReason.INVALID_REFERENCE_OPERATION);
  }
}

export type BalanceResult =
  | { ok: true; balance: Money }
  | { ok: false; reason: RejectionReason.INSUFFICIENT_FUNDS };

/** Aplica o efeito ao saldo sem nunca permitir saldo negativo. */
export function applyEffect(balance: Money, effect: BalanceEffect): BalanceResult {
  switch (effect.kind) {
    case 'NONE':
      return { ok: true, balance };
    case 'CREDIT':
      return { ok: true, balance: balance.add(effect.amount) };
    case 'DEBIT': {
      if (balance.isLessThan(effect.amount)) {
        return { ok: false, reason: RejectionReason.INSUFFICIENT_FUNDS };
      }
      return { ok: true, balance: balance.subtract(effect.amount) };
    }
  }
}

function reject(reason: RejectionReason): Decision {
  return { outcome: 'REJECT', reason };
}
