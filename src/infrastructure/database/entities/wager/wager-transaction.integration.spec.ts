import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../mikro-orm.config.js';
import {
  WagerOperation,
  WagerStatus,
  WagerTransaction,
} from './wager-transaction.entity.js';
import { Wallet } from '../wallet/wallet.entity.js';
import { randomUUID } from 'node:crypto';

describe('WagerTransaction - integração com PostgreSQL', () => {
  let orm: MikroORM;
  let walletId: string;
  let testId: string;
  let idempotencyKey: string;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    const em = orm.em.fork();

    testId = randomUUID();
    idempotencyKey = `test-bet-${randomUUID()}`;

    // Cria sempre uma carteira nova e exclusiva para este teste de integração
    const wallet = em.create(Wallet, {
      playerId: `test-player-${randomUUID()}`,
      currency: 'BRL',
      // Sem lançamento no ledger → saldo zero para não quebrar a reconciliação.
      balance: '0.00',
      lastLedgerSequence: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    em.persist(wallet);
    await em.flush();

    walletId = wallet.id;
  });

  it('persiste a transação e rejeita uma chave de idempotência duplicada', async () => {
    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(Wallet, {
      id: walletId,
    });
    const transaction = em.create(WagerTransaction, {
      id: testId,
      wallet,
      playerId: 'test-player',
      operation: WagerOperation.BET,
      status: WagerStatus.PENDING,
      idempotencyKey,
      payloadHash: 'a'.repeat(64),
      amount: '10.00',
      currency: 'BRL',
      referenceKey: null,
      referenceTransaction: null,
      response: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. Persiste a primeira transação.
    await em.transactional(async (tx) => {
      tx.persist(transaction);
      await tx.flush();
    });

    // 2. Limpa o contexto e consulta o registro novamente no banco.
    em.clear();

    const saved = await em.findOneOrFail(WagerTransaction, {
      id: testId,
    });

    expect(saved.id).toBe(testId);
    expect(saved.operation).toBe(WagerOperation.BET);
    expect(saved.status).toBe(WagerStatus.PENDING);
    expect(saved.amount).toBe('10.00');
    expect(saved.currency).toBe('BRL');
    expect(saved.idempotencyKey).toBe(idempotencyKey);
    expect(saved.payloadHash).toBe('a'.repeat(64));

    // Tenta gravar outra transação com ID novo e a mesma chave de idempotência.
    const duplicate = em.create(WagerTransaction, {
      id: randomUUID(),
      wallet,
      playerId: 'test-player',
      operation: WagerOperation.BET,
      status: WagerStatus.PENDING,
      idempotencyKey,
      payloadHash: 'b'.repeat(64),
      amount: '10.00',
      currency: 'BRL',
      referenceKey: null,
      referenceTransaction: null,
      response: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Valida que a transação falha devido à restrição de unicidade
    await expect(
      em.transactional(async (tx) => {
        tx.persist(duplicate);
        await tx.flush();
      }),
    ).rejects.toThrow(/unique|duplicate|wager_idempotency_key_unique/i);

    // A falha de flush deixa a entidade duplicada no contexto; verifique em
    // um EntityManager novo para não tentar persistir essa entidade novamente.
    const count = await orm.em.fork().count(WagerTransaction, {
      idempotencyKey,
    });

    expect(count).toBe(1);
  });

  afterAll(async () => {
    if (orm) {
      const em = orm.em.fork();

      if (testId) {
        await em.nativeDelete(WagerTransaction, { id: testId });
      }

      if (walletId) {
        await em.nativeDelete(Wallet, { id: walletId });
      }

      await orm.close(true);
    }
  });
});
