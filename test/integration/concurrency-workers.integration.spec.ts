import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InboxStatus } from '../../src/infrastructure/database/entities/messaging/inbox-message.entity.js';
import { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import { WagerInboxConsumer } from '../../src/modules/inbox/wager-inbox.consumer.js';
import {
  balanceOf,
  createTestApp,
  createWallet,
  key,
  reconcile,
  sql,
  type TestContext,
  wager,
} from './helpers.js';
import { runFixtureJson, skipMultiProcess } from './process.js';

interface WorkerResult {
  key: string;
  pid: number;
  transactionId?: string;
  status?: string;
  replayed?: boolean;
  error?: string;
}

function shuffle<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

describe('Múltiplos processos e instâncias concorrentes (integração)', () => {
  // Três réplicas do serviço no mesmo teste, cada uma com seu pool de conexões.
  const instances: TestContext[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      instances.push(await createTestApp());
    }
  });

  afterAll(async () => {
    await Promise.all(instances.map((i) => i.app.close()));
  });

  describe.skipIf(skipMultiProcess)('processos separados (bun)', () => {
    it('4 processos disputando as mesmas 30 chaves: cada chave executa uma vez e o saldo nunca fica negativo', async () => {
      const [a] = instances;
      const wallet = await createWallet(a, '100.00');
      const keys = Array.from({ length: 30 }, () => key('proc'));

      const outputs = await Promise.all(
        Array.from({ length: 4 }, () =>
          runFixtureJson<WorkerResult[]>('bet-worker.ts', {
            WALLET_ID: wallet.id,
            PLAYER_ID: wallet.playerId,
            AMOUNT: '7.00',
            KEYS: shuffle(keys).join(','),
          }),
        ),
      );

      const results = outputs.flat();
      expect(results.filter((r) => r.error)).toEqual([]);
      expect(new Set(results.map((r) => r.pid)).size).toBe(4);

      for (const k of keys) {
        const forKey = results.filter((r) => r.key === k);
        expect(forKey).toHaveLength(4);
        expect(forKey.filter((r) => !r.replayed)).toHaveLength(1);
        expect(new Set(forKey.map((r) => r.transactionId)).size).toBe(1);
        expect(new Set(forKey.map((r) => r.status)).size).toBe(1);
      }

      const processed = new Set(
        results.filter((r) => r.status === 'PROCESSED').map((r) => r.key),
      );
      expect(processed.size).toBe(14); // floor(100 / 7)

      expect(await reconcile(a, wallet.id)).toMatchObject({
        balance: '2.00',
        ledger: '2.00',
        entries: 15,
        contiguous: true,
      });
    }, 120_000);
  });

  describe('várias instâncias da API', () => {
    it('duas apostas de R$ 80 em instâncias diferentes contra R$ 100', async () => {
      const [a, b] = instances;

      for (let round = 0; round < 10; round++) {
        const wallet = await createWallet(a, '100.00');
        const body = (k: string) => ({
          walletId: wallet.id,
          playerId: wallet.playerId,
          operation: 'BET' as const,
          amount: '80.00',
          idempotencyKey: k,
        });

        const [r1, r2] = await Promise.all([wager(a, body(key('a'))), wager(b, body(key('b')))]);

        expect([r1.status, r2.status].sort()).toEqual([201, 422]);
        expect(await balanceOf(a, wallet.id)).toBe('20.00');
      }
    });

    it('50 requisições idênticas distribuídas entre 3 instâncias → um débito', async () => {
      const wallet = await createWallet(instances[0], '100.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '10.00',
        idempotencyKey: key('spread'),
      };

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) => wager(instances[i % 3], body)),
      );

      expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
      expect(await reconcile(instances[0], wallet.id)).toMatchObject({
        balance: '90.00',
        entries: 2,
        contiguous: true,
      });
    });

    it('3 consumidores recebendo a MESMA mensagem ao mesmo tempo (entrega duplicada)', async () => {
      const wallet = await createWallet(instances[0], '100.00');
      const message = {
        MessageId: randomUUID(),
        ReceiptHandle: 'rh',
        Body: JSON.stringify({
          walletId: wallet.id,
          playerId: wallet.playerId,
          operation: 'BET',
          amount: '15.00',
          currency: 'BRL',
          idempotencyKey: key('dup-delivery'),
        }),
        Attributes: { ApproximateReceiveCount: '1' },
      };

      const results = await Promise.all(
        instances.map((i) => i.app.get(WagerInboxConsumer).handle(message)),
      );

      expect(results.filter((r) => r === 'processed').length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r === 'processed' || r === 'duplicate')).toBe(true);
      expect(await balanceOf(instances[0], wallet.id)).toBe('85.00');

      const inbox = await sql<{ status: string }>(
        instances[0],
        'select status from inbox_messages where message_id = ?',
        [message.MessageId],
      );
      expect(inbox).toEqual([{ status: InboxStatus.PROCESSED }]);
    });

    it('3 publicadores do Outbox em paralelo não publicam o mesmo evento duas vezes', async () => {
      const wallet = await createWallet(instances[0], '1000.00');
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          wager(instances[i % 3], {
            walletId: wallet.id,
            playerId: wallet.playerId,
            operation: 'BET',
            amount: '1.00',
            idempotencyKey: key('pubs'),
          }),
        ),
      );

      const drain = async (ctx: TestContext) => {
        const publisher = ctx.app.get(OutboxPublisher);
        for (let i = 0; i < 200; i++) {
          if ((await publisher.publishBatch()).claimed === 0) return;
        }
      };
      await Promise.all(instances.map(drain));

      const sent = instances.flatMap((i) =>
        i.sqs.calls.filter(
          (c) => c.name === 'SendMessageCommand' && c.input.MessageGroupId === wallet.id,
        ),
      );
      const ids = sent.map((c) => c.input.MessageDeduplicationId);
      expect(ids).toHaveLength(41); // wallet.created + 40 apostas
      expect(new Set(ids).size).toBe(41);

      const pending = await sql<{ n: number }>(
        instances[0],
        `select count(*)::int as n from outbox_events where partition_key = ? and status <> 'PUBLISHED'`,
        [wallet.id],
      );
      expect(pending[0].n).toBe(0);
    });
  });
});
