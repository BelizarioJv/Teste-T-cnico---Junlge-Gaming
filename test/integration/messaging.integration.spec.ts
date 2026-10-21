import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxStatus } from '../../src/infrastructure/database/entities/messaging/inbox-message.entity.js';
import { OutboxStatus } from '../../src/infrastructure/database/entities/messaging/outbox-event.entity.js';
import { WagerInboxConsumer } from '../../src/modules/inbox/wager-inbox.consumer.js';
import { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import { WageringService } from '../../src/modules/wagering/wagering.service.js';
import {
  balanceOf,
  createTestApp,
  createWallet,
  key,
  type TestContext,
  wager,
} from './helpers.js';

function sqsMessage(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    MessageId: randomUUID(),
    ReceiptHandle: `rh-${randomUUID()}`,
    Body: typeof body === 'string' ? body : JSON.stringify(body),
    Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'g1' },
    ...overrides,
  };
}

async function sql<T>(ctx: TestContext, query: string, params: unknown[] = []): Promise<T[]> {
  return (await ctx.orm.em.fork().getConnection().execute(query, params)) as T[];
}

describe('Inbox / Outbox (integração com PostgreSQL, SQS falso)', () => {
  let ctx: TestContext;
  let consumer: WagerInboxConsumer;
  let publisher: OutboxPublisher;

  beforeAll(async () => {
    ctx = await createTestApp();
    consumer = ctx.app.get(WagerInboxConsumer);
    publisher = ctx.app.get(OutboxPublisher);
  });

  beforeEach(() => {
    ctx.sqs.calls.length = 0;
    ctx.sqs.failWhen = () => false;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('consumidor SQS + Inbox', () => {
    it('processa a mensagem, marca o Inbox e remove da fila', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const message = sqsMessage({
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '25.00',
        currency: 'BRL',
        idempotencyKey: key('sqs'),
      });

      expect(await consumer.handle(message)).toBe('processed');
      expect(await balanceOf(ctx, wallet.id)).toBe('75.00');

      const [inbox] = await sql<{ status: string; transaction_id: string | null }>(
        ctx,
        'select status, transaction_id from inbox_messages where message_id = ?',
        [message.MessageId],
      );
      expect(inbox.status).toBe(InboxStatus.PROCESSED);
      expect(inbox.transaction_id).not.toBeNull();
      expect(ctx.sqs.calls.map((c) => c.name)).toEqual(['DeleteMessageCommand']);
    });

    it('redelivery da mesma mensagem não reprocessa', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const message = sqsMessage({
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        currency: 'BRL',
        idempotencyKey: key('sqs'),
      });

      expect(await consumer.handle(message)).toBe('processed');
      expect(
        await consumer.handle({ ...message, Attributes: { ApproximateReceiveCount: '2' } }),
      ).toBe('duplicate');
      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
    });

    it('mesma operação reenviada como outra mensagem vira replay (idempotencyKey)', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        currency: 'BRL',
        idempotencyKey: key('sqs'),
      };

      expect(await consumer.handle(sqsMessage(body))).toBe('processed');
      expect(await consumer.handle(sqsMessage(body))).toBe('processed');
      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
    });

    it('HTTP e SQS com a mesma chave em paralelo → um único débito', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '10.00',
        currency: 'BRL',
        idempotencyKey: key('mixed'),
      };

      await Promise.all([
        ...Array.from({ length: 10 }, () => consumer.handle(sqsMessage(body))),
        ...Array.from({ length: 10 }, () => wager(ctx, body)),
      ]);

      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
    });

    it.each([
      ['JSON inválido', '{not json'],
      ['payload inválido', { walletId: 'x', operation: 'BET' }],
      ['carteira inexistente', {
        walletId: '00000000-0000-4000-8000-000000000000',
        playerId: 'p',
        operation: 'BET',
        amount: '1.00',
        currency: 'BRL',
        idempotencyKey: 'k-missing-wallet',
      }],
    ])('%s → erro permanente: DLQ explícita + Inbox FAILED', async (_label, body) => {
      const message = sqsMessage(body);

      expect(await consumer.handle(message)).toBe('dead-lettered');

      const names = ctx.sqs.calls.map((c) => c.name);
      expect(names).toEqual(['SendMessageCommand', 'DeleteMessageCommand']);
      expect(String(ctx.sqs.calls[0].input.QueueUrl)).toContain('dlq');

      const [inbox] = await sql<{ status: string }>(
        ctx,
        'select status from inbox_messages where message_id = ?',
        [message.MessageId],
      );
      expect(inbox.status).toBe(InboxStatus.FAILED);
    });

    it('se a DLQ falhar, a mensagem não é removida nem marcada FAILED', async () => {
      const message = sqsMessage('{broken');
      ctx.sqs.failWhen = (name) => name === 'SendMessageCommand';

      await expect(consumer.handle(message)).rejects.toThrow(/fake SQS failure/);

      expect(ctx.sqs.calls.map((c) => c.name)).not.toContain('DeleteMessageCommand');
      const [inbox] = await sql<{ status: string }>(
        ctx,
        'select status from inbox_messages where message_id = ?',
        [message.MessageId],
      );
      expect(inbox.status).toBe(InboxStatus.RECEIVED);
    });

    it('erro transitório → mantém na fila com backoff (redrive do SQS leva à DLQ)', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const message = sqsMessage({
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        currency: 'BRL',
        idempotencyKey: key('transient'),
      });

      const wagering = ctx.app.get(WageringService);
      const spy = vi
        .spyOn(wagering, 'process')
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      expect(await consumer.handle(message)).toBe('retry');
      expect(ctx.sqs.calls.map((c) => c.name)).toEqual(['ChangeMessageVisibilityCommand']);

      const [inbox] = await sql<{ status: string; attempts: number; last_error: string }>(
        ctx,
        'select status, attempts, last_error from inbox_messages where message_id = ?',
        [message.MessageId],
      );
      expect(inbox).toMatchObject({ status: InboxStatus.RECEIVED, attempts: 1 });
      expect(inbox.last_error).toMatch(/connection terminated/);
      spy.mockRestore();

      // Redelivery: agora o banco "voltou".
      expect(
        await consumer.handle({ ...message, Attributes: { ApproximateReceiveCount: '2' } }),
      ).toBe('processed');
      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
    });
  });

  describe('publicador do Outbox', () => {
    async function drain(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const stats = await publisher.publishBatch();
        if (stats.claimed === 0) return;
      }
    }

    async function eventsFor(walletId: string) {
      return sql<{ status: string; attempts: number; next_attempt_at: Date; last_error: string | null }>(
        ctx,
        'select status, attempts, next_attempt_at, last_error from outbox_events where partition_key = ? order by created_at',
        [walletId],
      );
    }

    it('publica pendentes com MessageGroupId da carteira e dedup pelo id do evento', async () => {
      const wallet = await createWallet(ctx, '100.00');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '1.00',
        idempotencyKey: key('pub'),
      }).expect(201);

      await drain();

      const events = await eventsFor(wallet.id);
      expect(events.map((e) => e.status)).toEqual([OutboxStatus.PUBLISHED, OutboxStatus.PUBLISHED]);

      const sent = ctx.sqs.calls.filter(
        (c) => c.name === 'SendMessageCommand' && c.input.MessageGroupId === wallet.id,
      );
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((c) => c.input.MessageDeduplicationId)).size).toBe(2);
    });

    it('falha de publicação agenda retry com backoff e preserva a ordem da carteira', async () => {
      const wallet = await createWallet(ctx, '100.00');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '1.00',
        idempotencyKey: key('pub'),
      }).expect(201);

      ctx.sqs.failWhen = (name, input) =>
        name === 'SendMessageCommand' && input.MessageGroupId === wallet.id;

      await drain();

      const events = await eventsFor(wallet.id);
      expect(events.map((e) => e.status)).toEqual([OutboxStatus.PENDING, OutboxStatus.PENDING]);
      // O primeiro falhou (tentativa contada); o segundo nunca foi enviado:
      // ficou retido atrás do primeiro para não ultrapassá-lo.
      expect(events[0].attempts).toBeGreaterThanOrEqual(1);
      expect(events[1].attempts).toBe(0);
      expect(new Date(events[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(events[1].next_attempt_at).getTime()).toBeGreaterThanOrEqual(
        new Date(events[0].next_attempt_at).getTime(),
      );
      expect(
        ctx.sqs.calls.filter(
          (c) =>
            c.name === 'SendMessageCommand' &&
            c.input.MessageGroupId === wallet.id &&
            (c.input.MessageBody as string).includes('wager.transaction'),
        ),
      ).toHaveLength(0);
      expect(events[0].last_error).toMatch(/fake SQS failure/);
    });

    it('após reinício (lease expirado), eventos travados são retomados', async () => {
      const wallet = await createWallet(ctx, '100.00');

      // Simula um publicador que fez o CLAIM e morreu antes do ACK.
      await sql(
        ctx,
        `update outbox_events set locked_until = now() - interval '1 second', attempts = 1 where partition_key = ?`,
        [wallet.id],
      );

      await drain();

      const events = await eventsFor(wallet.id);
      expect(events.map((e) => e.status)).toEqual([OutboxStatus.PUBLISHED]);
    });

    it('vários publicadores concorrentes não publicam o mesmo evento duas vezes', async () => {
      const wallet = await createWallet(ctx, '1000.00');
      await Promise.all(
        Array.from({ length: 30 }, () =>
          wager(ctx, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            operation: 'BET',
            amount: '1.00',
            idempotencyKey: key('multi'),
          }),
        ),
      );

      await Promise.all([drain(), drain(), drain(), drain()]);

      const sent = ctx.sqs.calls.filter(
        (c) => c.name === 'SendMessageCommand' && c.input.MessageGroupId === wallet.id,
      );
      const ids = sent.map((c) => c.input.MessageDeduplicationId);
      expect(ids).toHaveLength(31); // wallet.created + 30 apostas
      expect(new Set(ids).size).toBe(31);
    });
  });
});
