import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';

import { Money, MoneyError } from '../../domain/money/money.js';
import { LedgerReferenceType } from '../../infrastructure/database/entities/ledger-entry.entity.js';
import { Wallet } from '../../infrastructure/database/entities/wallet/wallet.entity.js';
import { postToWallet } from '../ledger/ledger.writer.js';
import { enqueueOutboxEvent } from '../outbox/outbox.writer.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { toWalletView, type WalletView } from './wallet.presenter.js';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /**
   * Cria a carteira e, se houver saldo inicial, o lançamento OPENING no
   * ledger — tudo na mesma transação SQL.
   */
  async createWallet(dto: CreateWalletDto): Promise<WalletView> {
    const playerId = dto.playerId.trim();

    if (!playerId) {
      throw new BadRequestException('playerId é obrigatório.');
    }

    const initialBalance = this.parseMoney(
      dto.initialBalance ?? '0.00',
      dto.currency,
    );

    try {
      const wallet = await this.orm.em.fork().transactional(async (em) => {
        const now = new Date();
        const wallet = new Wallet();
        wallet.playerId = playerId;
        wallet.currency = initialBalance.currency;
        wallet.balance = '0.00';
        wallet.lastLedgerSequence = 0;
        wallet.createdAt = now;
        wallet.updatedAt = now;
        em.persist(wallet);

        if (!initialBalance.isZero()) {
          postToWallet(
            em,
            wallet,
            { kind: 'CREDIT', amount: initialBalance },
            {
              referenceType: LedgerReferenceType.OPENING,
              referenceId: wallet.id,
            },
          );
        }

        enqueueOutboxEvent(em, {
          aggregateType: 'wallet',
          aggregateId: wallet.id,
          eventType: 'wallet.created',
          partitionKey: wallet.id,
          payload: { wallet: { ...toWalletView(wallet) } },
        });

        await em.flush();

        return wallet;
      });

      this.logger.log({
        msg: 'wallet.created',
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
      });

      return toWalletView(wallet);
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.orm.em
          .fork()
          .findOne(Wallet, { playerId, currency: initialBalance.currency });

        throw new ConflictException({
          code: 'WALLET_ALREADY_EXISTS',
          message: 'Já existe uma carteira para este jogador nesta moeda.',
          walletId: existing?.id ?? null,
        });
      }

      throw error;
    }
  }

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.orm.em.fork().findOne(Wallet, { id: walletId });

    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Carteira não encontrada.',
      });
    }

    return toWalletView(wallet);
  }

  private parseMoney(amount: string, currency: string): Money {
    try {
      return Money.from({ amount, currency });
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
