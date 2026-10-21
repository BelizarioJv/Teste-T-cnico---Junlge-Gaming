import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  balanceOf,
  createTestApp,
  createWallet,
  key,
  reconcile,
  type TestContext,
  wager,
} from './helpers.js';

describe('Wallet + Wagering (integração com PostgreSQL)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  // ------------------------------------------------------------------ Wallet
  describe('POST /wallets', () => {
    it('cria a carteira com lançamento OPENING no ledger', async () => {
      const wallet = await createWallet(ctx, '100.00');

      const res = await ctx.http().get(`/wallets/${wallet.id}`).expect(200);
      expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(res.body.ledgerSequence).toBe(1);

      const ledger = await ctx.http().get(`/wallets/${wallet.id}/ledger`).expect(200);
      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.items[0]).toMatchObject({
        sequence: 1,
        type: 'CREDIT',
        referenceType: 'OPENING',
        amount: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
      });
    });

    it('carteira com saldo zero não gera lançamento', async () => {
      const wallet = await createWallet(ctx, '0');
      const ledger = await ctx.http().get(`/wallets/${wallet.id}/ledger`).expect(200);
      expect(ledger.body.items).toHaveLength(0);
    });

    it('rejeita jogador+moeda duplicados com 409', async () => {
      const wallet = await createWallet(ctx);
      const res = await ctx
        .http()
        .post('/wallets')
        .send({ playerId: wallet.playerId, currency: 'BRL' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', walletId: wallet.id });
    });

    it.each([
      [{ playerId: 'p', currency: 'brl' }],
      [{ playerId: 'p', currency: 'BRL', initialBalance: '-1' }],
      [{ playerId: 'p', currency: 'BRL', initialBalance: '10.999' }],
      [{ playerId: 'p', currency: 'BRL', extra: true }],
    ])('valida o payload (%j) com 400', async (body) => {
      await ctx.http().post('/wallets').send(body).expect(400);
    });
  });

  // --------------------------------------------------------------------- BET
  describe('BET', () => {
    it('debita o saldo e grava o ledger atomicamente', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const idempotencyKey = key('bet');

      const res = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '30.00',
        idempotencyKey,
      }).expect(201);

      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body).toMatchObject({
        status: 'PROCESSED',
        operation: 'BET',
        amount: { amount: '30.00', currency: 'BRL' },
        balance: { amount: '70.00', currency: 'BRL' },
        reason: null,
      });

      const ledger = await ctx.http().get(`/wallets/${wallet.id}/ledger`).expect(200);
      expect(ledger.body.items[0]).toMatchObject({
        sequence: 2,
        type: 'DEBIT',
        referenceType: 'BET',
        referenceId: res.body.transactionId,
        balanceAfter: { amount: '70.00', currency: 'BRL' },
      });

      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '70.00',
        ledger: '70.00',
        contiguous: true,
      });
    });

    it('saldo insuficiente → 422 REJECTED, saldo e ledger intactos', async () => {
      const wallet = await createWallet(ctx, '50.00');

      const res = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '50.01',
        idempotencyKey: key('bet'),
      }).expect(422);

      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
      expect(await balanceOf(ctx, wallet.id)).toBe('50.00');
      expect((await reconcile(ctx, wallet.id)).entries).toBe(1);
    });

    it('aposta exatamente igual ao saldo zera a carteira', async () => {
      const wallet = await createWallet(ctx, '80.00');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '80',
        idempotencyKey: key('bet'),
      }).expect(201);
      expect(await balanceOf(ctx, wallet.id)).toBe('0.00');
    });

    it('replay idêntico devolve o mesmo status e corpo sem debitar de novo', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '10.00',
        idempotencyKey: key('bet'),
      };

      const first = await wager(ctx, body).expect(201);
      const second = await wager(ctx, body).expect(201);
      // "10" normaliza para "10.00": mesmo payload.
      const third = await wager(ctx, { ...body, amount: '10' }).expect(201);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
      expect((await reconcile(ctx, wallet.id)).entries).toBe(2);
    });

    it('replay de uma rejeição também é idêntico (422)', async () => {
      const wallet = await createWallet(ctx, '1.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '5.00',
        idempotencyKey: key('bet'),
      };

      const first = await wager(ctx, body).expect(422);
      const second = await wager(ctx, body).expect(422);
      expect(second.body).toEqual(first.body);
    });

    it('mesma chave com payload diferente → 409', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const idempotencyKey = key('bet');

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        idempotencyKey,
      }).expect(201);

      const res = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '20.00',
        idempotencyKey,
      }).expect(409);

      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(ctx, wallet.id)).toBe('90.00');
    });

    it('carteira inexistente → 404; jogador errado → 422; moeda errada → 422', async () => {
      const wallet = await createWallet(ctx);
      const base = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '1.00',
      };

      await wager(ctx, { ...base, walletId: '00000000-0000-4000-8000-000000000000', idempotencyKey: key() }).expect(404);
      await wager(ctx, { ...base, playerId: 'intruso', idempotencyKey: key() }).expect(422);
      await wager(ctx, { ...base, currency: 'USD', idempotencyKey: key() }).expect(422);
    });
  });

  // ------------------------------------------------------------- Concorrência
  describe('concorrência', () => {
    it('50 requisições idênticas em paralelo → um único débito', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const body = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET' as const,
        amount: '10.00',
        idempotencyKey: key('parallel'),
      };

      const responses = await Promise.all(
        Array.from({ length: 50 }, () => wager(ctx, body)),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
      expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
      expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);

      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '90.00',
        ledger: '90.00',
        entries: 2,
        contiguous: true,
      });
    });

    it('duas apostas de R$ 80 concorrendo por R$ 100 → uma aceita, uma rejeitada', async () => {
      for (let round = 0; round < 10; round++) {
        const wallet = await createWallet(ctx, '100.00');
        const bet = (k: string) =>
          wager(ctx, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            operation: 'BET',
            amount: '80.00',
            idempotencyKey: k,
          });

        const [a, b] = await Promise.all([bet(key('a')), bet(key('b'))]);

        expect([a.status, b.status].sort()).toEqual([201, 422]);
        expect([a.body.status, b.body.status].sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect(await reconcile(ctx, wallet.id)).toMatchObject({
          balance: '20.00',
          ledger: '20.00',
          contiguous: true,
        });
      }
    });

    it('carga mista com duplicatas nunca deixa saldo negativo nem diverge do ledger', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const keys = Array.from({ length: 40 }, () => key('mix'));
      const calls = [...keys, ...keys.slice(0, 15)].sort(() => Math.random() - 0.5);

      await Promise.all(
        calls.map((k) =>
          wager(ctx, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            operation: 'BET',
            amount: '7.00',
            idempotencyKey: k,
          }),
        ),
      );

      // floor(100 / 7) = 14 apostas aceitas, saldo final 2.00
      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '2.00',
        ledger: '2.00',
        entries: 15,
        contiguous: true,
      });
    });
  });

  // ------------------------------------------------- WIN / LOSS / REFUND / ROLLBACK
  describe('operações derivadas', () => {
    async function placeBet(amount = '40.00') {
      const wallet = await createWallet(ctx, '100.00');
      const betKey = key('bet');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount,
        idempotencyKey: betKey,
      }).expect(201);
      return { wallet, betKey };
    }

    it('WIN credita o prêmio e não permite segunda liquidação', async () => {
      const { wallet, betKey } = await placeBet();

      const win = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'WIN',
        amount: '100.00',
        idempotencyKey: key('win'),
        referenceKey: betKey,
      }).expect(201);
      expect(win.body.balance.amount).toBe('160.00');

      const second = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'LOSS',
        amount: '0.00',
        idempotencyKey: key('loss'),
        referenceKey: betKey,
      }).expect(422);
      expect(second.body.reason).toBe('BET_ALREADY_SETTLED');
    });

    it('LOSS liquida sem movimentar saldo nem ledger', async () => {
      const { wallet, betKey } = await placeBet();
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'LOSS',
        amount: '0.00',
        idempotencyKey: key('loss'),
        referenceKey: betKey,
      }).expect(201);

      expect(await reconcile(ctx, wallet.id)).toMatchObject({ balance: '60.00', entries: 2 });
    });

    it('REFUND devolve o valor exato da aposta', async () => {
      const { wallet, betKey } = await placeBet();

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'REFUND',
        amount: '39.99',
        idempotencyKey: key('refund'),
        referenceKey: betKey,
      }).expect(422);

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'REFUND',
        amount: '40.00',
        idempotencyKey: key('refund'),
        referenceKey: betKey,
      }).expect(201);

      expect(await balanceOf(ctx, wallet.id)).toBe('100.00');
    });

    it('ROLLBACK de WIN debita; segundo ROLLBACK é rejeitado', async () => {
      const { wallet, betKey } = await placeBet();
      const winKey = key('win');
      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'WIN',
        amount: '25.00',
        idempotencyKey: winKey,
        referenceKey: betKey,
      }).expect(201);

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'ROLLBACK',
        amount: '25.00',
        idempotencyKey: key('rb'),
        referenceKey: winKey,
      }).expect(201);

      const again = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'ROLLBACK',
        amount: '25.00',
        idempotencyKey: key('rb'),
        referenceKey: winKey,
      }).expect(422);

      expect(again.body.reason).toBe('TRANSACTION_ALREADY_REVERSED');
      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '60.00',
        ledger: '60.00',
        contiguous: true,
      });
    });
  });

  // ---------------------------------------------------- PENDING_REFERENCE
  describe('referências fora de ordem (PENDING_REFERENCE)', () => {
    it('ROLLBACK antes do BET fica pendente e é aplicado quando o BET chega', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const betKey = key('bet');

      const rollback = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'ROLLBACK',
        amount: '30.00',
        idempotencyKey: key('rb'),
        referenceKey: betKey,
      }).expect(202);
      expect(rollback.body.status).toBe('PENDING_REFERENCE');
      expect(await balanceOf(ctx, wallet.id)).toBe('100.00');

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '30.00',
        idempotencyKey: betKey,
      }).expect(201);

      const resolved = await ctx
        .http()
        .get(`/wagering/transactions/${rollback.body.transactionId}`)
        .expect(200);

      expect(resolved.body).toMatchObject({
        status: 'PROCESSED',
        referenceKey: betKey,
        balance: { amount: '100.00', currency: 'BRL' },
      });
      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '100.00',
        ledger: '100.00',
        entries: 3,
        contiguous: true,
      });
    });

    it('resolve em cascata: WIN e ROLLBACK(WIN) chegam antes do BET', async () => {
      const wallet = await createWallet(ctx, '100.00');
      const betKey = key('bet');
      const winKey = key('win');

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'ROLLBACK',
        amount: '50.00',
        idempotencyKey: key('rb'),
        referenceKey: winKey,
      }).expect(202);

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'WIN',
        amount: '50.00',
        idempotencyKey: winKey,
        referenceKey: betKey,
      }).expect(202);

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        idempotencyKey: betKey,
      }).expect(201);

      // BET -10, WIN +50, ROLLBACK -50
      expect(await reconcile(ctx, wallet.id)).toMatchObject({
        balance: '90.00',
        ledger: '90.00',
        entries: 4,
        contiguous: true,
      });
    });

    it('derivada de um BET rejeitado é rejeitada quando o BET chega', async () => {
      const wallet = await createWallet(ctx, '5.00');
      const betKey = key('bet');

      const win = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'WIN',
        amount: '10.00',
        idempotencyKey: key('win'),
        referenceKey: betKey,
      }).expect(202);

      await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '10.00',
        idempotencyKey: betKey,
      }).expect(422);

      const resolved = await ctx
        .http()
        .get(`/wagering/transactions/${win.body.transactionId}`)
        .expect(200);
      expect(resolved.body).toMatchObject({
        status: 'REJECTED',
        reason: 'REFERENCE_NOT_PROCESSED',
      });
      expect(await balanceOf(ctx, wallet.id)).toBe('5.00');
    });
  });

  // ------------------------------------------------------------ Leitura
  describe('GET', () => {
    it('ledger paginado por cursor, mais recente primeiro, sem duplicar nem pular', async () => {
      const wallet = await createWallet(ctx, '100.00');
      for (let i = 0; i < 6; i++) {
        await wager(ctx, {
          walletId: wallet.id,
          playerId: wallet.playerId,
          operation: 'BET',
          amount: '1.00',
          idempotencyKey: key('page'),
        }).expect(201);
      }

      const seen: number[] = [];
      let cursor: number | null = null;
      do {
        const res: { body: { items: Array<{ sequence: number }>; nextCursor: number | null } } =
          await ctx
          .http()
          .get(`/wallets/${wallet.id}/ledger`)
          .query(cursor ? { limit: 3, before: cursor } : { limit: 3 })
          .expect(200);
        seen.push(...res.body.items.map((i: { sequence: number }) => i.sequence));
        cursor = res.body.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });

    it('valida parâmetros de paginação e ids', async () => {
      const wallet = await createWallet(ctx);
      await ctx.http().get(`/wallets/${wallet.id}/ledger`).query({ limit: 0 }).expect(400);
      await ctx.http().get(`/wallets/${wallet.id}/ledger`).query({ limit: 101 }).expect(400);
      await ctx.http().get('/wallets/not-a-uuid').expect(400);
      await ctx.http().get('/wagering/transactions/00000000-0000-4000-8000-000000000000').expect(404);
    });
  });

  // ---------------------------------------------------- Garantias do banco
  describe('garantias do banco', () => {
    it('ledger é imutável (UPDATE e DELETE falham)', async () => {
      const wallet = await createWallet(ctx, '10.00');
      const conn = ctx.orm.em.fork().getConnection();

      await expect(
        conn.execute('update ledger_entries set amount = 1 where wallet_id = ?', [wallet.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        conn.execute('delete from ledger_entries where wallet_id = ?', [wallet.id]),
      ).rejects.toThrow(/append-only/);
    });

    it('CHECK impede saldo negativo mesmo fora da aplicação', async () => {
      const wallet = await createWallet(ctx, '10.00');
      await expect(
        ctx.orm.em
          .fork()
          .getConnection()
          .execute('update wallets set balance = -0.01 where id = ?', [wallet.id]),
      ).rejects.toThrow(/wallets_balance_non_negative/);
    });

    it('cada transação gera evento no Outbox na mesma transação', async () => {
      const wallet = await createWallet(ctx, '10.00');
      const res = await wager(ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '1.00',
        idempotencyKey: key('outbox'),
      }).expect(201);

      const rows = (await ctx.orm.em
        .fork()
        .getConnection()
        .execute('select event_type from outbox_events where aggregate_id = ?', [
          res.body.transactionId,
        ])) as Array<{ event_type: string }>;

      expect(rows.map((r) => r.event_type)).toEqual(['wager.transaction.processed']);
    });
  });
});
