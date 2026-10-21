import type { EntityManager } from '@mikro-orm/core';

import { Money } from '../../domain/money/money.js';
import {
  applyEffect,
  type BalanceEffect,
  type BalanceResult,
} from '../../domain/wagering/wager-rules.js';
import {
  LedgerEntry,
  LedgerEntryType,
  LedgerReferenceType,
} from '../../infrastructure/database/entities/ledger-entry.entity.js';
import { Wallet } from '../../infrastructure/database/entities/wallet/wallet.entity.js';
import { WagerOperation } from '../../domain/wagering/wager.types.js';

const LEDGER_REFERENCE_BY_OPERATION: Record<WagerOperation, LedgerReferenceType> = {
  [WagerOperation.BET]: LedgerReferenceType.BET,
  [WagerOperation.WIN]: LedgerReferenceType.WIN,
  [WagerOperation.LOSS]: LedgerReferenceType.LOSS,
  [WagerOperation.REFUND]: LedgerReferenceType.REFUND,
  [WagerOperation.ROLLBACK]: LedgerReferenceType.ROLLBACK,
};

export function ledgerReferenceFor(operation: WagerOperation): LedgerReferenceType {
  return LEDGER_REFERENCE_BY_OPERATION[operation];
}

export interface LedgerReference {
  referenceType: LedgerReferenceType;
  referenceId: string;
}

export function walletBalance(wallet: Wallet): Money {
  return Money.from({ amount: wallet.balance, currency: wallet.currency });
}

/**
 * Único ponto do sistema que altera `wallets.balance`.
 *
 * Pré-condição: `wallet` foi carregada com `SELECT ... FOR UPDATE` na
 * transação corrente de `em`. Saldo e lançamento são alterados juntos e
 * gravados no mesmo flush/commit, então nunca divergem.
 *
 * Retorna `{ ok: false }` (sem alterar nada) quando um débito deixaria o
 * saldo negativo.
 */
export function postToWallet(
  em: EntityManager,
  wallet: Wallet,
  effect: BalanceEffect,
  reference: LedgerReference,
): BalanceResult {
  const current = walletBalance(wallet);
  const result = applyEffect(current, effect);

  if (!result.ok || effect.kind === 'NONE') {
    return result;
  }

  const sequence = wallet.lastLedgerSequence + 1;

  const entry = new LedgerEntry();
  entry.wallet = wallet;
  entry.sequence = sequence;
  entry.type =
    effect.kind === 'DEBIT' ? LedgerEntryType.DEBIT : LedgerEntryType.CREDIT;
  entry.amount = effect.amount.toString();
  entry.currency = wallet.currency;
  entry.balanceAfter = result.balance.toString();
  entry.referenceType = reference.referenceType;
  entry.referenceId = reference.referenceId;
  entry.createdAt = new Date();

  wallet.balance = result.balance.toString();
  wallet.lastLedgerSequence = sequence;

  em.persist(entry);

  return result;
}
