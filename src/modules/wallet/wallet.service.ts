import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/core';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../infrastructure/database/entities/wallet.entity.js';
import {
  LedgerEntry,
  LedgerEntryType,
  LedgerReferenceType,
} from '../../infrastructure/database/entities/ledger-entry.entity.js';

@Injectable()
export class WalletService {
  constructor(private readonly em: EntityManager) {}

  async createWallet(playerId: string, initialBalance: Money): Promise<Wallet> {
    if (!playerId.trim()) {
      throw new Error('playerId é obrigatório');
    }

    if (initialBalance.isNegative()) {
      throw new Error('O saldo inicial não pode ser negativo');
    }

    return this.em.transactional(async (em) => {
      const wallet = em.create(Wallet, {
        playerId,
        currency: initialBalance.currency,
        balance: initialBalance.toJSON().amount,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      em.persist(wallet);

      if (initialBalance.isPositive()) {
        const openingEntry = em.create(LedgerEntry, {
          wallet,
          type: LedgerEntryType.CREDIT,
          amount: initialBalance.toJSON().amount,
          currency: initialBalance.currency,
          referenceType: LedgerReferenceType.OPENING,
          referenceId: wallet.id,
          createdAt: new Date(),
        });

        em.persist(openingEntry);
      }

      return wallet;
    });
  }
}
