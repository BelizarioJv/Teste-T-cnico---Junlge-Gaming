import type { MoneyProps } from '../../domain/money/money.js';
import type { Wallet } from '../../infrastructure/database/entities/wallet/wallet.entity.js';
import { walletBalance } from '../ledger/ledger.writer.js';

export interface WalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  /** Sequência do último lançamento no ledger. */
  ledgerSequence: number;
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: walletBalance(wallet).toJSON(),
    ledgerSequence: wallet.lastLedgerSequence,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
