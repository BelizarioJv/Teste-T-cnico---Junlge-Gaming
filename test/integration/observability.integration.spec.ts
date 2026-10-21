import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAppConfig } from '../../src/config/app-config.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import type { WagerInboxConsumer } from '../../src/modules/inbox/wager-inbox.consumer.js';
import type { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import {
  createFakeSqs,
  createTestApp,
  createWallet,
  key,
  sql,
  type TestContext,
  wager,
} from './helpers.js';

describe('Health, métricas, logs e reconciliação (integração)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('health', () => {
    it('GET /health/live → 200', async () => {
      const res = await ctx.http().get('/health/live').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('GET /health/ready → 200 com banco e schema ok, workers desligados', async () => {
      const res = await ctx.http().get('/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.database.status).toBe('ok');
      expect(res.body.checks.schema.status).toBe('ok');
      expect(res.body.checks.sqs.status).toBe('skipped');
      expect(res.body.checks.shutdown.status).toBe('ok');
    });

    function manualHealth(options: { sqsFails?: boolean; running?: boolean }) {
      const config = loadAppConfig();
      config.sqs.consumerEnabled = true;
      config.health.timeoutMs = 500;
      const sqs = createFakeSqs();
      sqs.failWhen = () => options.sqsFails ?? false;
      const worker = { isRunning: () => options.running ?? true };

      return new HealthService(
        config,
        ctx.orm,
        sqs as never,
        worker as unknown as WagerInboxConsumer,
        worker as unknown as OutboxPublisher,
      );
    }

    it('não fica pronto se o SQS estiver inacessível', async () => {
      const report = await manualHealth({ sqsFails: true }).ready();
      expect(report.status).toBe('error');
      expect(report.checks.sqs).toMatchObject({ status: 'error' });
    });

    it('não fica pronto se o loop do consumidor parou', async () => {
      const report = await manualHealth({ running: false }).ready();
      expect(report.status).toBe('error');
      expect(report.checks.sqsConsumer.status).toBe('error');
    });

    it('sai do balanceador durante o shutdown', async () => {
      const health = manualHealth({});
      expect((await health.ready()).status).toBe('ok');
      health.beforeApplicationShutdown();
      const report = await health.ready();
      expect(report.status).toBe('error');
      expect(report.checks.shutdown.status).toBe('error');
    });
  });

  describe('métricas e correlação', () => {
    it('propaga X-Request-Id recebido e gera um quando ausente', async () => {
      const echoed = await ctx.http().get('/health/live').set('X-Request-Id', 'abc-123').expect(200);
      expect(echoed.headers['x-request-id']).toBe('abc-123');

      const generated = await ctx.http().get('/health/live').expect(200);
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

      const rejected = await ctx.http().get('/health/live').set('X-Request-Id', 'bad id with spaces').expect(200);
      expect(rejected.headers['x-request-id']).not.toBe('bad id with spaces');
    });

    it('GET /metrics expõe métricas de negócio, HTTP (rota template) e do banco', async () => {
      const wallet = await createWallet(ctx, '10.00');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '1.00',
        idempotencyKey: key('metrics'),
      }).expect(201);
      await ctx.http().get(`/wallets/${wallet.id}`).expect(200);

      const res = await ctx.http().get('/metrics').expect(200);
      expect(res.headers['content-type']).toContain('text/plain');

      const text = res.text;
      expect(text).toMatch(/wager_transactions_total\{operation="BET",status="PROCESSED"\} \d+/);
      expect(text).toMatch(/http_requests_total\{method="GET",route="\/wallets\/:id",status="200"\} \d+/);
      expect(text).toMatch(/http_request_duration_seconds_count\{method="POST",route="\/wagering\/transactions"\} \d+/);
      expect(text).toMatch(/outbox_events\{status="PENDING"\} \d+/);
      expect(text).toMatch(/wager_pending_reference_transactions \d+/);
      expect(text).not.toContain(wallet.id); // sem ids nas labels
    });

    it('conta replays separadamente das decisões', async () => {
      const wallet = await createWallet(ctx, '10.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '1.00',
        idempotencyKey: key('replay-metric'),
      };

      const metric = async () => {
        const text = (await ctx.http().get('/metrics')).text;
        const match = /wager_idempotent_replays_total\{operation="BET"\} (\d+)/.exec(text);
        return Number(match?.[1] ?? 0);
      };

      const before = await metric();
      await wager(ctx, body).expect(201);
      await wager(ctx, body).expect(201);
      await wager(ctx, body).expect(201);
      expect((await metric()) - before).toBe(2);
    });
  });

  describe('reconciliação', () => {
    it('carteira operada pela API está consistente', async () => {
      const wallet = await createWallet(ctx, '100.00');
      for (const amount of ['10.00', '20.00']) {
        await wager(ctx, {
          walletId: wallet.id,
          playerId: wallet.playerId,
          operation: 'BET',
          amount,
          idempotencyKey: key('rec'),
        }).expect(201);
      }

      const res = await ctx.http().get(`/wallets/${wallet.id}/reconciliation`).expect(200);
      expect(res.body).toMatchObject({
        consistent: true,
        balance: '70.00',
        ledgerBalance: '70.00',
        entries: 3,
        maxSequence: 3,
        issues: [],
      });
    });

    it('detecta saldo alterado por fora do ledger e reflete na métrica', async () => {
      const wallet = await createWallet(ctx, '50.00');

      // Simula uma escrita indevida direto no banco.
      await sql(ctx, 'update wallets set balance = balance + 5 where id = ?', [wallet.id]);

      try {
        const single = await ctx.http().get(`/wallets/${wallet.id}/reconciliation`).expect(200);
        expect(single.body).toMatchObject({
          consistent: false,
          difference: '5.00',
          issues: ['BALANCE_MISMATCH', 'LAST_BALANCE_AFTER_MISMATCH'],
        });

        const run = await ctx.http().post('/reconciliation/runs').expect(201);
        expect(run.body.inconsistentWallets).toBeGreaterThanOrEqual(1);
        expect(run.body.inconsistencies.map((w: { walletId: string }) => w.walletId)).toContain(wallet.id);

        const last = await ctx.http().get('/reconciliation/last').expect(200);
        expect(last.body.finishedAt).toBe(run.body.finishedAt);

        const metrics = (await ctx.http().get('/metrics')).text;
        expect(metrics).toMatch(/reconciliation_inconsistent_wallets [1-9]\d*/);
      } finally {
        // Desfaz a corrupção para não afetar outros testes.
        await sql(ctx, 'update wallets set balance = balance - 5 where id = ?', [wallet.id]);
      }

      const fixed = await ctx.http().get(`/wallets/${wallet.id}/reconciliation`).expect(200);
      expect(fixed.body.consistent).toBe(true);
    });

    it('404 para carteira inexistente', async () => {
      await ctx
        .http()
        .get('/wallets/00000000-0000-4000-8000-000000000000/reconciliation')
        .expect(404);
    });
  });
});
