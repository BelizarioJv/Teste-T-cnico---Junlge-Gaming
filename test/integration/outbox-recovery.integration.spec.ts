import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OutboxStatus } from '../../src/infrastructure/database/entities/messaging/outbox-event.entity.js';
import { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import {
  createTestApp,
  createWallet,
  key,
  sql,
  type TestContext,
  wager,
  waitFor,
} from './helpers.js';
import { skipMultiProcess, startFixture } from './process.js';

interface EventRow {
  status: string;
  attempts: number;
  locked_until: Date | null;
}

const eventsOf = (ctx: TestContext, walletId: string) =>
  sql<EventRow>(
    ctx,
    'select status, attempts, locked_until from outbox_events where partition_key = ? order by created_at, id',
    [walletId],
  );

async function drainAll(ctx: TestContext): Promise<void> {
  const publisher = ctx.app.get(OutboxPublisher);
  for (let i = 0; i < 500; i++) {
    if ((await publisher.publishBatch()).claimed === 0) return;
  }
}

async function walletWithEvents(ctx: TestContext, bets: number) {
  const wallet = await createWallet(ctx, '100.00');
  for (let i = 0; i < bets; i++) {
    await wager(ctx, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      operation: 'BET',
      amount: '1.00',
      idempotencyKey: key('recovery'),
    }).expect(201);
  }
  return wallet;
}

describe('Outbox: reinício e recuperação (integração)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ env: { OUTBOX_LEASE_MS: '1000', OUTBOX_BATCH_SIZE: '100' } });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe.skipIf(skipMultiProcess)('processo morto com SIGKILL no meio da publicação', () => {
    it('eventos reservados pelo processo morto são publicados após o lease expirar', async () => {
      await drainAll(ctx); // garante que o worker só vai reservar os eventos deste teste
      const wallet = await walletWithEvents(ctx, 3);

      const worker = startFixture('outbox-crash-worker.ts', {
        OUTBOX_LEASE_MS: '1500',
        OUTBOX_BATCH_SIZE: '100',
      });

      await worker.waitForOutput('CLAIMED_AND_SENDING');
      worker.child.kill('SIGKILL');
      await worker.exited;

      // O processo morreu entre CLAIM e ACK: eventos reservados e pendentes.
      const orphaned = await eventsOf(ctx, wallet.id);
      expect(orphaned).toHaveLength(4);
      expect(orphaned.every((e) => e.status === OutboxStatus.PENDING && e.attempts === 1)).toBe(true);
      expect(orphaned.every((e) => e.locked_until !== null)).toBe(true);

      // Enquanto o lease vale, outro publicador não os toca.
      await ctx.app.get(OutboxPublisher).publishBatch();
      expect((await eventsOf(ctx, wallet.id)).every((e) => e.status === OutboxStatus.PENDING)).toBe(true);

      // Lease expirado → retomados e publicados (at-least-once).
      await new Promise((r) => setTimeout(r, 1700));
      await drainAll(ctx);

      const recovered = await eventsOf(ctx, wallet.id);
      expect(recovered.map((e) => e.status)).toEqual(Array(4).fill(OutboxStatus.PUBLISHED));
      expect(recovered.every((e) => e.attempts === 2)).toBe(true);
    }, 90_000);
  });

  it('ACK tardio de um publicador que perdeu o lease não sobrescreve a publicação', async () => {
    await drainAll(ctx);
    const wallet = await walletWithEvents(ctx, 1);

    // Instância "lenta": o SQS dela trava até liberarmos.
    const slow = await createTestApp({ env: { OUTBOX_LEASE_MS: '500', OUTBOX_BATCH_SIZE: '100' } });
    let release: (error: Error) => void = () => undefined;
    slow.sqs.send.mockImplementation(
      () => new Promise((_, reject) => {
        release = reject;
      }),
    );

    try {
      const slowBatch = slow.app.get(OutboxPublisher).publishBatch();

      await waitFor(
        async () => (await eventsOf(ctx, wallet.id)).every((e) => e.locked_until !== null),
        { label: 'claim da instância lenta' },
      );
      await new Promise((r) => setTimeout(r, 700)); // lease de 500 ms expira

      await drainAll(ctx);
      expect((await eventsOf(ctx, wallet.id)).map((e) => e.status)).toEqual([
        OutboxStatus.PUBLISHED,
        OutboxStatus.PUBLISHED,
      ]);

      // A instância lenta "acorda" com erro e tenta agendar retry.
      release(new Error('timeout tardio'));
      await slowBatch;

      expect((await eventsOf(ctx, wallet.id)).map((e) => e.status)).toEqual([
        OutboxStatus.PUBLISHED,
        OutboxStatus.PUBLISHED,
      ]);
    } finally {
      await slow.app.close();
    }
  });

  it('eventos gravados com o publicador desligado são publicados quando uma instância reinicia com ele ligado', async () => {
    const wallet = await walletWithEvents(ctx, 2);
    expect((await eventsOf(ctx, wallet.id)).every((e) => e.status === OutboxStatus.PENDING)).toBe(true);

    const restarted = await createTestApp({
      env: { OUTBOX_PUBLISHER_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '100' },
    });

    try {
      await waitFor(
        async () =>
          (await eventsOf(ctx, wallet.id)).every((e) => e.status === OutboxStatus.PUBLISHED),
        { label: 'publicação após reinício', timeoutMs: 30_000 },
      );

      const ready = await restarted.http().get('/health/ready').expect(200);
      expect(ready.body.checks.outboxPublisher.status).toBe('ok');
    } finally {
      await restarted.app.close();
    }
  });

  it('shutdown gracioso aguarda o lote em andamento', async () => {
    const instance = await createTestApp({
      env: { OUTBOX_PUBLISHER_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '100' },
    });
    const publisher = instance.app.get(OutboxPublisher);
    expect(publisher.isRunning()).toBe(true);

    await instance.app.close();
    expect(publisher.isRunning()).toBe(false);
  });
});
