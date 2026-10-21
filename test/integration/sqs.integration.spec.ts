import {
  GetQueueAttributesCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadAppConfig } from '../../src/config/app-config.js';
import { WageringService } from '../../src/modules/wagering/wagering.service.js';
import {
  balanceOf,
  createTestApp,
  createWallet,
  key,
  sql,
  type TestContext,
  waitFor,
} from './helpers.js';

/**
 * Integração com SQS real (ElasticMQ do docker-compose, ou LocalStack).
 * Pulado se a fila não responder — exceto com REQUIRE_SQS=1 (CI).
 */
const config = loadAppConfig();
const client = new SQSClient({
  region: config.sqs.region,
  endpoint: config.sqs.endpoint,
  credentials: {
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
});

async function sqsReachable(): Promise<boolean> {
  try {
    await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: config.sqs.wagerQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return true;
  } catch {
    return false;
  }
}

const reachable = await sqsReachable();

if (!reachable && process.env.REQUIRE_SQS === '1') {
  throw new Error(`SQS inacessível em ${config.sqs.endpoint} e REQUIRE_SQS=1`);
}

async function receiveAll(queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const res = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      MessageAttributeNames: ['All'],
    }),
  );
  return res.Messages ?? [];
}

async function findInQueue(
  queueUrl: string,
  predicate: (m: Message) => boolean,
  timeoutMs = 30_000,
): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await receiveAll(queueUrl)).find(predicate);
    if (found) {
      return found;
    }
  }
  throw new Error(`Mensagem não encontrada em ${queueUrl}`);
}

function sendCommand(body: Record<string, unknown>, groupId: string) {
  return client.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.wagerQueueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: String(body.idempotencyKey ?? key('dedup')),
    }),
  );
}

describe.skipIf(!reachable)('SQS real: consumidor, DLQ, redrive e Outbox (integração)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await Promise.all(
      [config.sqs.wagerQueueUrl, config.sqs.wagerDlqUrl, config.sqs.eventsQueueUrl].map((QueueUrl) =>
        client.send(new PurgeQueueCommand({ QueueUrl })).catch(() => undefined),
      ),
    );

    ctx = await createTestApp({
      sqs: 'real',
      env: {
        SQS_CONSUMER_ENABLED: 'true',
        OUTBOX_PUBLISHER_ENABLED: 'true',
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_RETRY_BASE_MS: '300',
        SQS_RETRY_MAX_MS: '1000',
        OUTBOX_POLL_INTERVAL_MS: '100',
      },
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
    client.destroy();
  });

  it('readiness verifica as filas reais', async () => {
    const res = await ctx.http().get('/health/ready').expect(200);
    expect(res.body.checks.sqs.status).toBe('ok');
    expect(res.body.checks.sqsConsumer.status).toBe('ok');
  });

  it('comando enviado à fila é processado e o evento sai pelo Outbox', async () => {
    const wallet = await createWallet(ctx, '100.00');
    const idempotencyKey = key('sqs-e2e');

    await sendCommand(
      {
        walletId: wallet.id,
        playerId: wallet.playerId,
        operation: 'BET',
        amount: '12.50',
        currency: 'BRL',
        idempotencyKey,
      },
      wallet.id,
    );

    await waitFor(async () => (await balanceOf(ctx, wallet.id)) === '87.50', {
      label: 'débito via SQS',
    });

    const event = await findInQueue(config.sqs.eventsQueueUrl, (m) => {
      const body = JSON.parse(m.Body ?? '{}') as { transaction?: { idempotencyKey?: string } };
      return body.transaction?.idempotencyKey === idempotencyKey;
    });
    expect(event.MessageAttributes?.eventType?.StringValue).toBe('wager.transaction.processed');
  });

  it('mensagem inválida vai para a DLQ com o motivo', async () => {
    const marker = key('poison');
    await sendCommand({ idempotencyKey: marker, operation: 'BET' }, 'poison');

    const dead = await findInQueue(config.sqs.wagerDlqUrl, (m) => (m.Body ?? '').includes(marker));
    expect(dead.MessageAttributes?.errorCode?.StringValue).toBeDefined();

    const [inbox] = await sql<{ status: string }>(
      ctx,
      `select status from inbox_messages where payload->>'idempotencyKey' = ?`,
      [marker],
    );
    expect(inbox.status).toBe('FAILED');
  });

  it(`erro transitório persistente: após ${config.sqs.maxReceiveCount} recebimentos o SQS move para a DLQ`, async () => {
    const wallet = await createWallet(ctx, '100.00');
    const idempotencyKey = key('redrive');

    const spy = vi
      .spyOn(ctx.app.get(WageringService), 'process')
      .mockRejectedValue(new Error('database unavailable'));

    try {
      await sendCommand(
        {
          walletId: wallet.id,
          playerId: wallet.playerId,
          operation: 'BET',
          amount: '1.00',
          currency: 'BRL',
          idempotencyKey,
        },
        wallet.id,
      );

      const dead = await findInQueue(
        config.sqs.wagerDlqUrl,
        (m) => (m.Body ?? '').includes(idempotencyKey),
        45_000,
      );
      expect(dead).toBeDefined();
      // Redrive nativo: não foi a aplicação que enviou (sem atributo errorCode).
      expect(dead.MessageAttributes?.errorCode).toBeUndefined();

      const [inbox] = await sql<{ status: string; attempts: number }>(
        ctx,
        `select status, attempts from inbox_messages where payload->>'idempotencyKey' = ?`,
        [idempotencyKey],
      );
      expect(inbox.status).toBe('RECEIVED');
      expect(inbox.attempts).toBe(config.sqs.maxReceiveCount);
      expect(await balanceOf(ctx, wallet.id)).toBe('100.00');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
