import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import { vi } from 'vitest';

import { CORE_IMPORTS } from '../../src/app.module.js';
import type { ApplicationOrm } from '../../src/infrastructure/database/orm.types.js';
import { SQS_CLIENT } from '../../src/infrastructure/sqs/sqs.module.js';
import { configureApp } from '../../src/observability/configure-app.js';

/** Cliente SQS falso que registra os comandos enviados. */
export interface FakeSqs {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  failWhen: (name: string, input: Record<string, unknown>) => boolean;
  send: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

export function createFakeSqs(): FakeSqs {
  const fake: FakeSqs = {
    calls: [],
    failWhen: () => false,
    send: vi.fn(),
    destroy: () => undefined,
  };

  fake.send.mockImplementation(
    async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      const name = command.constructor.name;
      fake.calls.push({ name, input: command.input });

      if (fake.failWhen(name, command.input)) {
        throw new Error(`fake SQS failure on ${name}`);
      }

      if (name === 'ReceiveMessageCommand') {
        // Simula long polling para o loop não girar em vazio.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return { Messages: [] };
    },
  );

  return fake;
}

export interface TestContext {
  app: INestApplication;
  orm: ApplicationOrm;
  sqs: FakeSqs;
  http: () => ReturnType<typeof request>;
}

export interface TestAppOptions {
  /** Variáveis de ambiente aplicadas só durante a criação desta instância. */
  env?: Record<string, string>;
  /** 'fake' (padrão) substitui o cliente SQS; 'real' usa o endpoint do .env. */
  sqs?: 'fake' | 'real';
}

/**
 * Sobe a aplicação real (PostgreSQL real). Por padrão o SQS é substituído
 * por um fake e os loops de polling ficam desligados; os testes chamam
 * `handle()` / `publishBatch()` diretamente para serem determinísticos.
 *
 * Cada chamada cria uma instância independente (pool de conexões próprio),
 * o que permite simular várias réplicas do serviço no mesmo teste.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  const env = {
    SQS_CONSUMER_ENABLED: 'false',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    RECONCILIATION_INTERVAL_MS: '0',
    ...options.env,
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);

  const sqs = createFakeSqs();

  try {
    let builder = Test.createTestingModule({ imports: CORE_IMPORTS });

    if (options.sqs !== 'real') {
      builder = builder.overrideProvider(SQS_CLIENT).useValue(sqs);
    }

    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();

    const orm = app.get<ApplicationOrm>(MikroORM);
    await assertSchemaIsMigrated(orm);

    return {
      app,
      orm,
      sqs,
      http: () => request(app.getHttpServer()),
    };
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** Executa SQL bruto (fora de transação) e devolve as linhas. */
export async function sql<T = Record<string, unknown>>(
  ctx: { orm: ApplicationOrm },
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await ctx.orm.em
    .fork()
    .getConnection()
    .execute(query, params)) as T[];
}

/** Espera até `predicate` ser verdadeiro (ou estoura o tempo). */
export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 200, label = 'condição' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Tempo esgotado aguardando ${label}`);
}

async function assertSchemaIsMigrated(orm: ApplicationOrm): Promise<void> {
  const rows = await orm.em
    .fork()
    .getConnection()
    .execute(
      `select count(*)::int as n from information_schema.tables where table_name in ('outbox_events', 'inbox_messages')`,
    );

  if (Number((rows as Array<{ n: number }>)[0]?.n ?? 0) !== 2) {
    throw new Error(
      'Schema desatualizado. Rode `bun run migration:up` antes dos testes de integração.',
    );
  }
}

export function uniquePlayer(): string {
  return `player-${randomUUID()}`;
}

export function key(prefix = 'tx'): string {
  return `${prefix}-${randomUUID()}`;
}

export async function createWallet(
  ctx: TestContext,
  initialBalance = '100.00',
): Promise<{ id: string; playerId: string }> {
  const playerId = uniquePlayer();
  const res = await ctx
    .http()
    .post('/wallets')
    .send({ playerId, currency: 'BRL', initialBalance })
    .expect(201);

  return { id: res.body.id as string, playerId };
}

export interface WagerBody {
  walletId: string;
  playerId: string;
  operation: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  currency?: string;
  idempotencyKey: string;
  referenceKey?: string;
}

export function wager(ctx: TestContext, body: WagerBody) {
  return ctx
    .http()
    .post('/wagering/transactions')
    .send({ currency: 'BRL', ...body });
}

export async function balanceOf(
  ctx: TestContext,
  walletId: string,
): Promise<string> {
  const res = await ctx.http().get(`/wallets/${walletId}`).expect(200);
  return res.body.balance.amount as string;
}

/** Soma do ledger vs saldo materializado + continuidade da sequência. */
export async function reconcile(
  ctx: TestContext,
  walletId: string,
): Promise<{
  balance: string;
  ledger: string;
  entries: number;
  contiguous: boolean;
}> {
  const rows = (await ctx.orm.em
    .fork()
    .getConnection()
    .execute(
      `select w.balance::text as balance,
              coalesce(sum(case when l.type = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger,
              count(l.id)::int as entries,
              coalesce(max(l.sequence), 0)::int as max_seq,
              w.last_ledger_sequence as last_seq
         from wallets w left join ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    )) as Array<{
    balance: string;
    ledger: string;
    entries: number;
    max_seq: number;
    last_seq: number;
  }>;

  const row = rows[0];

  return {
    balance: row.balance,
    ledger: row.ledger,
    entries: row.entries,
    contiguous: row.entries === row.max_seq && row.max_seq === row.last_seq,
  };
}
