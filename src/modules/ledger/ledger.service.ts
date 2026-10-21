import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

import type { MoneyProps } from '../../domain/money/money.js';
import { LedgerEntry } from '../../infrastructure/database/entities/ledger-entry.entity.js';
import { Wallet } from '../../infrastructure/database/entities/wallet/wallet.entity.js';
import { LedgerQueryDto } from './dto/ledger-query.dto.js';

export interface LedgerEntryView {
  id: string;
  sequence: number;
  type: string;
  amount: MoneyProps;
  balanceAfter: MoneyProps;
  referenceType: string;
  referenceId: string;
  createdAt: string;
}

export interface LedgerPage {
  walletId: string;
  items: LedgerEntryView[];
  /** Passe como `before` para obter a próxima página; null = fim. */
  nextCursor: number | null;
}

const DEFAULT_LIMIT = 20;

@Injectable()
export class LedgerService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /**
   * Paginação keyset pela sequência por carteira (mais recente primeiro).
   * Estável mesmo com inserções concorrentes: novos lançamentos têm sequência
   * maior e nunca deslocam páginas já lidas.
   */
  async listByWallet(walletId: string, query: LedgerQueryDto): Promise<LedgerPage> {
    const em = this.orm.em.fork();
    const limit = query.limit ?? DEFAULT_LIMIT;

    const exists = await em.count(Wallet, { id: walletId });

    if (exists === 0) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Carteira não encontrada.',
      });
    }

    const entries = await em.find(
      LedgerEntry,
      query.before !== undefined
        ? { wallet: walletId, sequence: { $lt: query.before } }
        : { wallet: walletId },
      { orderBy: { sequence: 'desc' }, limit: limit + 1 },
    );

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    return {
      walletId,
      items: page.map(toLedgerEntryView),
      nextCursor: hasMore ? page[page.length - 1].sequence : null,
    };
  }
}

export function toLedgerEntryView(entry: LedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    sequence: entry.sequence,
    type: entry.type,
    amount: { amount: entry.amount, currency: entry.currency },
    balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt.toISOString(),
  };
}
