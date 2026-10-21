import 'dotenv/config';

/**
 * Configuração tipada lida uma única vez do ambiente.
 * Valores inválidos falham na inicialização, não em runtime.
 */
export interface AppConfig {
  port: number;
  sqs: {
    region: string;
    endpoint: string | undefined;
    accessKeyId: string;
    secretAccessKey: string;
    /** Fila de entrada com comandos de aposta (FIFO). */
    wagerQueueUrl: string;
    /** DLQ da fila de entrada (FIFO). */
    wagerDlqUrl: string;
    /** Fila de saída para eventos do Outbox (FIFO). */
    eventsQueueUrl: string;
    consumerEnabled: boolean;
    waitTimeSeconds: number;
    maxMessages: number;
    /** Deve ser igual ao maxReceiveCount da redrive policy. */
    maxReceiveCount: number;
    /** Backoff (visibility timeout) para erros transitórios. */
    retryBaseMs: number;
    retryMaxMs: number;
  };
  outbox: {
    publisherEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };
  reconciliation: {
    /** 0 = desligado. */
    intervalMs: number;
    batchSize: number;
  };
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'pretty';
  };
  health: {
    timeoutMs: number;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function int(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Variável de ambiente ${name} inválida: ${raw}`);
  }

  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Variável de ambiente ${name} inválida: ${raw} (use ${allowed.join(', ')})`);
  }

  return raw as T;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadAppConfig(): AppConfig {
  const endpoint = str('SQS_ENDPOINT', 'http://localhost:9324');

  return {
    port: int('PORT', 3000),
    sqs: {
      region: str('AWS_REGION', 'us-east-1'),
      endpoint: endpoint || undefined,
      accessKeyId: str('SQS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str('SQS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueUrl: str(
        'SQS_WAGER_QUEUE_URL',
        `${endpoint}/000000000000/wager-transactions.fifo`,
      ),
      wagerDlqUrl: str(
        'SQS_WAGER_DLQ_URL',
        `${endpoint}/000000000000/wager-transactions-dlq.fifo`,
      ),
      eventsQueueUrl: str(
        'SQS_EVENTS_QUEUE_URL',
        `${endpoint}/000000000000/wallet-events.fifo`,
      ),
      consumerEnabled: bool('SQS_CONSUMER_ENABLED', false),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 10),
      maxMessages: Math.min(int('SQS_MAX_MESSAGES', 10), 10),
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 3),
      retryBaseMs: int('SQS_RETRY_BASE_MS', 2000),
      retryMaxMs: int('SQS_RETRY_MAX_MS', 5 * 60_000),
    },
    outbox: {
      publisherEnabled: bool('OUTBOX_PUBLISHER_ENABLED', false),
      pollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 1000),
      batchSize: int('OUTBOX_BATCH_SIZE', 20),
      leaseMs: int('OUTBOX_LEASE_MS', 30_000),
      maxAttempts: int('OUTBOX_MAX_ATTEMPTS', 10),
      baseBackoffMs: int('OUTBOX_BASE_BACKOFF_MS', 1000),
      maxBackoffMs: int('OUTBOX_MAX_BACKOFF_MS', 5 * 60_000),
    },
    reconciliation: {
      intervalMs: int('RECONCILIATION_INTERVAL_MS', 0),
      batchSize: Math.max(1, int('RECONCILIATION_BATCH_SIZE', 500)),
    },
    log: {
      level: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
      format: oneOf('LOG_FORMAT', ['json', 'pretty'] as const, 'json'),
    },
    health: {
      timeoutMs: int('HEALTH_TIMEOUT_MS', 2000),
    },
  };
}
