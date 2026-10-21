import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type EntityManager,
  LockMode,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';

import { Money, MoneyError } from '../../domain/money/money.js';
import {
  assertCommandShape,
  decideBet,
  decideDerived,
  type Decision,
  type ReferenceTarget,
  WagerValidationError,
} from '../../domain/wagering/wager-rules.js';
import {
  REVERSAL_OPERATIONS,
  SETTLEMENT_OPERATIONS,
  WagerOperation,
  WagerStatus,
} from '../../domain/wagering/wager.types.js';
import {
  InboxMessage,
  InboxStatus,
} from '../../infrastructure/database/entities/messaging/inbox-message.entity.js';
import { WagerTransaction } from '../../infrastructure/database/entities/wager/wager-transaction.entity.js';
import { Wallet } from '../../infrastructure/database/entities/wallet/wallet.entity.js';
import {
  ledgerReferenceFor,
  postToWallet,
  walletBalance,
} from '../ledger/ledger.writer.js';
import { AppMetrics } from '../../observability/app-metrics.js';
import { enqueueOutboxEvent } from '../outbox/outbox.writer.js';
import { CreateWagerDto } from './dto/create-wager.dto.js';
import { generatePayloadHash } from './utils/payload-hash.js';
import {
  storedView,
  toWagerView,
  type WagerTransactionView,
} from './wagering.presenter.js';

export interface ProcessOptions {
  /** Quando vindo do SQS: marca a mensagem do Inbox na mesma transação. */
  inboxMessageId?: string;
}

export interface WagerOutcome {
  view: WagerTransactionView;
  status: WagerStatus;
  /** true quando a resposta veio de uma execução anterior (idempotência). */
  replayed: boolean;
}

interface NormalizedCommand {
  walletId: string;
  playerId: string;
  operation: WagerOperation;
  amount: Money;
  idempotencyKey: string;
  referenceKey: string | null;
  payloadHash: string;
}

/**
 * Processamento de operações de aposta.
 *
 * Garantias:
 * - Atomicidade: transação, saldo, ledger, outbox e inbox são gravados no
 *   mesmo COMMIT.
 * - Isolamento: `SELECT ... FOR UPDATE` na carteira serializa todas as
 *   operações sobre ela (READ COMMITTED + lock pessimista). Duas apostas de
 *   R$ 80 contra R$ 100 nunca leem o mesmo saldo.
 * - Idempotência: a chave é verificada sob o lock; a constraint UNIQUE
 *   cobre a corrida residual (mesma chave em carteiras diferentes) e o
 *   conflito vira replay.
 * - Saldo nunca negativo: verificado na regra e garantido por CHECK no banco.
 */
@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
  ) {}

  async process(
    input: CreateWagerDto,
    options: ProcessOptions = {},
  ): Promise<WagerOutcome> {
    const command = this.normalize(input);
    // Decisões tomadas na transação; só viram métrica depois do COMMIT.
    const decided: WagerTransaction[] = [];

    try {
      const outcome = await this.orm.em
        .fork()
        .transactional((em) => this.processLocked(em, command, options, decided));

      this.recordMetrics(outcome, decided);

      this.logger.log({
        msg: outcome.replayed ? 'wager.replayed' : 'wager.processed',
        transactionId: outcome.view.transactionId,
        idempotencyKey: command.idempotencyKey,
        walletId: command.walletId,
        operation: command.operation,
        status: outcome.status,
        reason: outcome.view.reason,
      });

      return outcome;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Outra transação gravou a mesma idempotencyKey entre nossa leitura e
        // o INSERT (só possível quando a chave é usada em outra carteira).
        // A transação perdedora foi revertida por completo: devolvemos a
        // resposta da vencedora.
        const replay = await this.replayAfterConflict(command, options);

        if (replay) {
          this.recordMetrics(replay, []);
          return replay;
        }
      }

      throw error;
    }
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.orm.em
      .fork()
      .findOne(WagerTransaction, { id: transactionId });

    if (!tx) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transação não encontrada.',
      });
    }

    return storedView(tx);
  }

  // ---------------------------------------------------------------- privado

  private recordMetrics(outcome: WagerOutcome, decided: WagerTransaction[]): void {
    if (outcome.replayed) {
      this.metrics.wagerReplays.inc({ operation: outcome.view.operation });
      return;
    }

    for (const tx of decided) {
      this.metrics.wagerTransactions.inc({ operation: tx.operation, status: tx.status });
    }
  }

  private async processLocked(
    em: EntityManager,
    command: NormalizedCommand,
    options: ProcessOptions,
    decided: WagerTransaction[],
  ): Promise<WagerOutcome> {
    // 1. Lock pessimista: serializa tudo que toca esta carteira.
    const wallet = await em.findOne(
      Wallet,
      { id: command.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Carteira não encontrada.',
      });
    }

    // 2. Idempotência sob o lock: requisições idênticas concorrentes na
    //    mesma carteira chegam aqui uma de cada vez e veem o COMMIT anterior.
    const existing = await em.findOne(WagerTransaction, {
      idempotencyKey: command.idempotencyKey,
    });

    if (existing) {
      const replay = this.replay(existing, command.payloadHash);
      await this.markInboxProcessed(em, options, existing.id);
      return replay;
    }

    // 3. Coerência do comando com a carteira.
    if (wallet.playerId !== command.playerId) {
      throw new UnprocessableEntityException({
        code: 'WALLET_PLAYER_MISMATCH',
        message: 'A carteira não pertence ao jogador informado.',
      });
    }

    if (wallet.currency !== command.amount.currency) {
      throw new UnprocessableEntityException({
        code: 'WALLET_CURRENCY_MISMATCH',
        message: 'A moeda não corresponde à moeda da carteira.',
      });
    }

    // 4. Registra a transação e decide o efeito.
    const now = new Date();
    const tx = new WagerTransaction();
    tx.wallet = wallet;
    tx.playerId = command.playerId;
    tx.operation = command.operation;
    tx.status = WagerStatus.PENDING;
    tx.idempotencyKey = command.idempotencyKey;
    tx.payloadHash = command.payloadHash;
    tx.amount = command.amount.toString();
    tx.currency = command.amount.currency;
    tx.referenceKey = command.referenceKey;
    tx.referenceTransaction = null;
    tx.response = null;
    tx.failureReason = null;
    tx.createdAt = now;
    tx.updatedAt = now;
    em.persist(tx);

    let decision: Decision;

    if (command.operation === WagerOperation.BET) {
      decision = decideBet(command.amount);
    } else {
      const target = await em.findOne(WagerTransaction, {
        idempotencyKey: command.referenceKey as string,
      });

      if (target) {
        tx.referenceTransaction = target;
      }

      decision = decideDerived(
        command.operation,
        command.amount,
        wallet.id,
        target ? await this.loadTarget(em, target) : null,
      );
    }

    this.resolve(em, wallet, tx, decision);
    decided.push(tx);
    await em.flush();

    // 5. Operações que chegaram antes desta (PENDING_REFERENCE) e
    //    aguardavam por ela são resolvidas na mesma transação.
    await this.resolvePendingChildren(em, wallet, tx, decided);

    await this.markInboxProcessed(em, options, tx.id);
    await em.flush();

    return { view: storedView(tx), status: tx.status, replayed: false };
  }

  /**
   * Aplica a decisão à transação (e à carteira, se for o caso) e registra o
   * evento no Outbox. `wallet` é a carteira travada; null quando a
   * transação pertence a outra carteira (só pode ser rejeitada).
   */
  private resolve(
    em: EntityManager,
    wallet: Wallet | null,
    tx: WagerTransaction,
    decision: Decision,
  ): void {
    switch (decision.outcome) {
      case 'WAIT':
        tx.status = WagerStatus.PENDING_REFERENCE;
        tx.failureReason = null;
        break;

      case 'REJECT':
        tx.status = WagerStatus.REJECTED;
        tx.failureReason = decision.reason;
        break;

      case 'APPLY': {
        if (!wallet || wallet.id !== tx.wallet.id) {
          // Nunca deve acontecer: decideDerived rejeita carteiras diferentes.
          throw new Error('Tentativa de movimentar carteira não travada.');
        }

        const result = postToWallet(em, wallet, decision.effect, {
          referenceType: ledgerReferenceFor(tx.operation),
          referenceId: tx.id,
        });

        if (result.ok) {
          tx.status = WagerStatus.PROCESSED;
          tx.failureReason = null;
        } else {
          tx.status = WagerStatus.REJECTED;
          tx.failureReason = result.reason;
        }
        break;
      }
    }

    tx.updatedAt = new Date();

    const balance =
      wallet && wallet.id === tx.wallet.id ? walletBalance(wallet).toJSON() : null;
    const view = toWagerView(tx, balance);
    tx.response = { ...view };

    enqueueOutboxEvent(em, {
      aggregateType: 'wager_transaction',
      aggregateId: tx.id,
      eventType: `wager.transaction.${tx.status.toLowerCase()}`,
      partitionKey: tx.wallet.id,
      payload: { transaction: { ...view } },
    });
  }

  /**
   * Resolve em cascata as operações que aguardavam `root`
   * (ex.: ROLLBACK que chegou antes do BET; ROLLBACK de um WIN que por sua
   * vez aguardava o BET).
   */
  private async resolvePendingChildren(
    em: EntityManager,
    wallet: Wallet,
    root: WagerTransaction,
    decided: WagerTransaction[],
  ): Promise<void> {
    const queue: WagerTransaction[] = [root];

    while (queue.length > 0) {
      const parent = queue.shift() as WagerTransaction;

      if (parent.status === WagerStatus.PENDING_REFERENCE) {
        continue;
      }

      const children = await em.find(
        WagerTransaction,
        { referenceKey: parent.idempotencyKey, status: WagerStatus.PENDING_REFERENCE },
        {
          orderBy: { createdAt: 'asc', id: 'asc' },
          lockMode: LockMode.PESSIMISTIC_WRITE,
        },
      );

      for (const child of children) {
        child.referenceTransaction = parent;

        const decision = decideDerived(
          child.operation,
          Money.from({ amount: child.amount, currency: child.currency }),
          child.wallet.id,
          await this.loadTarget(em, parent),
        );

        this.resolve(
          em,
          child.wallet.id === wallet.id ? wallet : null,
          child,
          decision,
        );
        decided.push(child);
        await em.flush();

        this.logger.log({
          msg: 'wager.pending_reference.resolved',
          transactionId: child.id,
          referenceTransactionId: parent.id,
          status: child.status,
          reason: child.failureReason,
        });

        queue.push(child);
      }
    }
  }

  private async loadTarget(
    em: EntityManager,
    target: WagerTransaction,
  ): Promise<ReferenceTarget> {
    // Sequencial: as duas consultas usam a mesma conexão da transação.
    const settled = await em.count(WagerTransaction, {
      referenceTransaction: target.id,
      operation: { $in: [...SETTLEMENT_OPERATIONS] },
      status: WagerStatus.PROCESSED,
    });
    const reversed = await em.count(WagerTransaction, {
      referenceTransaction: target.id,
      operation: { $in: [...REVERSAL_OPERATIONS] },
      status: WagerStatus.PROCESSED,
    });

    return {
      operation: target.operation,
      status: target.status,
      amount: Money.from({ amount: target.amount, currency: target.currency }),
      walletId: target.wallet.id,
      settled: settled > 0,
      reversed: reversed > 0,
    };
  }

  private replay(existing: WagerTransaction, payloadHash: string): WagerOutcome {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'A chave de idempotência já foi usada com outro payload.',
        transactionId: existing.id,
      });
    }

    return { view: storedView(existing), status: existing.status, replayed: true };
  }

  private async replayAfterConflict(
    command: NormalizedCommand,
    options: ProcessOptions,
  ): Promise<WagerOutcome | null> {
    const em = this.orm.em.fork();
    const existing = await em.findOne(WagerTransaction, {
      idempotencyKey: command.idempotencyKey,
    });

    if (!existing) {
      return null;
    }

    const outcome = this.replay(existing, command.payloadHash);
    await this.markInboxProcessed(em, options, existing.id);

    this.logger.log({
      msg: 'wager.replayed_after_conflict',
      transactionId: existing.id,
      idempotencyKey: command.idempotencyKey,
    });

    return outcome;
  }

  private async markInboxProcessed(
    em: EntityManager,
    options: ProcessOptions,
    transactionId: string,
  ): Promise<void> {
    if (!options.inboxMessageId) {
      return;
    }

    await em.nativeUpdate(
      InboxMessage,
      { id: options.inboxMessageId, status: { $ne: InboxStatus.PROCESSED } },
      {
        status: InboxStatus.PROCESSED,
        transactionId,
        processedAt: new Date(),
        lastError: null,
      },
    );
  }

  private normalize(input: CreateWagerDto): NormalizedCommand {
    let amount: Money;

    try {
      amount = Money.from({ amount: input.amount, currency: input.currency });
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const referenceKey = input.referenceKey ?? null;

    try {
      assertCommandShape(input.operation, amount, referenceKey, input.idempotencyKey);
    } catch (error) {
      if (error instanceof WagerValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    // O hash usa valores normalizados ("80" e "80.00" são o mesmo payload).
    const payloadHash = generatePayloadHash({
      walletId: input.walletId,
      playerId: input.playerId,
      operation: input.operation,
      amount: amount.toString(),
      currency: amount.currency,
      referenceKey,
    });

    return {
      walletId: input.walletId,
      playerId: input.playerId,
      operation: input.operation,
      amount,
      idempotencyKey: input.idempotencyKey,
      referenceKey,
      payloadHash,
    };
  }
}
