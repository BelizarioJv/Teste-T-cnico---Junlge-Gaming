/**
 * Smoke test end-to-end contra uma instância em execução.
 *
 *   bun run start            # em outro terminal
 *   bun run smoke            # BASE_URL=http://localhost:3000 por padrão
 *
 * Sai com código 1 na primeira verificação que falhar.
 */
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

interface HttpResult {
  status: number;
  body: any;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // corpo não-JSON (ex.: /metrics)
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? '✔' : '✘'} ${label}`);
  if (!condition) {
    failures += 1;
    if (detail !== undefined) {
      console.log('   ', JSON.stringify(detail));
    }
  }
}

async function waitReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ready = await call('GET', '/health/ready');
      if (ready.status === 200) return;
      if (Date.now() > deadline) throw new Error(JSON.stringify(ready.body));
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  await waitReady();

  const live = await call('GET', '/health/live');
  check(live.status === 200, 'GET /health/live → 200');
  const ready = await call('GET', '/health/ready');
  check(ready.status === 200, 'GET /health/ready → 200', ready.body);

  const playerId = `smoke-${randomUUID()}`;
  const wallet = await call('POST', '/wallets', { playerId, currency: 'BRL', initialBalance: '100.00' });
  check(wallet.status === 201, 'POST /wallets → 201', wallet.body);
  const walletId = wallet.body.id as string;

  const bet = (amount: string, idempotencyKey = `smoke-${randomUUID()}`) =>
    call('POST', '/wagering/transactions', {
      walletId,
      playerId,
      operation: 'BET',
      amount,
      currency: 'BRL',
      idempotencyKey,
    });

  const key = `smoke-${randomUUID()}`;
  const first = await bet('10.00', key);
  check(first.status === 201 && first.body.status === 'PROCESSED', 'BET → 201 PROCESSED', first.body);
  const replay = await bet('10.00', key);
  check(
    replay.status === 201 && replay.headers.get('idempotent-replayed') === 'true' &&
      replay.body.transactionId === first.body.transactionId,
    'replay idêntico → mesma resposta com Idempotent-Replayed: true',
  );
  const conflict = await call('POST', '/wagering/transactions', {
    walletId, playerId, operation: 'BET', amount: '11.00', currency: 'BRL', idempotencyKey: key,
  });
  check(conflict.status === 409, 'mesma chave com outro payload → 409');

  const insufficient = await bet('1000.00');
  check(insufficient.status === 422 && insufficient.body.reason === 'INSUFFICIENT_FUNDS', 'saldo insuficiente → 422');

  const [a, b] = await Promise.all([bet('80.00'), bet('80.00')]);
  check([a.status, b.status].sort().join() === '201,422', '2×R$80 concorrentes com R$90 → uma aceita, uma rejeitada', [a.body, b.body]);

  const parallelKey = `smoke-${randomUUID()}`;
  const parallel = await Promise.all(Array.from({ length: 50 }, () => bet('1.00', parallelKey)));
  check(new Set(parallel.map((r) => r.body.transactionId)).size === 1, '50 requisições idênticas em paralelo → uma transação');

  const state = await call('GET', `/wallets/${walletId}`);
  check(state.body.balance?.amount === '9.00', `saldo final 9.00 (atual: ${state.body.balance?.amount})`);

  const ledger = await call('GET', `/wallets/${walletId}/ledger?limit=2`);
  check(ledger.status === 200 && ledger.body.items.length === 2 && ledger.body.nextCursor !== null, 'ledger paginado');

  const transaction = await call('GET', `/wagering/transactions/${first.body.transactionId}`);
  check(transaction.status === 200 && transaction.body.idempotencyKey === key, 'GET /wagering/transactions/:id');

  const reconciliation = await call('GET', `/wallets/${walletId}/reconciliation`);
  check(reconciliation.body.consistent === true, 'reconciliação wallet × ledger consistente', reconciliation.body);

  const metrics = await call('GET', '/metrics');
  check(
    typeof metrics.body === 'string' && metrics.body.includes('wager_transactions_total'),
    'GET /metrics expõe wager_transactions_total',
  );

  if (failures > 0) {
    console.log(`\n${failures} verificação(ões) falharam.`);
    process.exitCode = 1;
  } else {
    console.log('\nSmoke test OK.');
  }
}

main().catch((error: unknown) => {
  console.error('Smoke test abortado:', error);
  process.exitCode = 1;
});
