import { MetricsRegistry } from './metrics.js';

/**
 * Métricas da aplicação. Uma instância por processo (provider global).
 */
export class AppMetrics {
  readonly registry = new MetricsRegistry();

  readonly httpRequests = this.registry.counter(
    'http_requests_total',
    'Requisições HTTP por método, rota e status.',
  );

  readonly httpDuration = this.registry.histogram(
    'http_request_duration_seconds',
    'Duração das requisições HTTP.',
  );

  readonly wagerTransactions = this.registry.counter(
    'wager_transactions_total',
    'Transações de aposta decididas, por operação e status (exclui replays).',
  );

  readonly wagerReplays = this.registry.counter(
    'wager_idempotent_replays_total',
    'Requisições respondidas por replay idempotente.',
  );

  readonly sqsMessages = this.registry.counter(
    'sqs_messages_total',
    'Mensagens SQS tratadas, por resultado (processed, duplicate, dead-lettered, retry).',
  );

  readonly outboxPublish = this.registry.counter(
    'outbox_publish_total',
    'Tentativas de publicação do Outbox, por resultado (published, retried, failed).',
  );

  readonly outboxEvents = this.registry.gauge(
    'outbox_events',
    'Eventos no Outbox por status (PENDING, FAILED).',
  );

  readonly outboxOldestPendingAge = this.registry.gauge(
    'outbox_oldest_pending_age_seconds',
    'Idade do evento pendente mais antigo no Outbox.',
  );

  readonly inboxFailed = this.registry.gauge(
    'inbox_failed_messages',
    'Mensagens do Inbox marcadas como FAILED (enviadas à DLQ).',
  );

  readonly pendingReferences = this.registry.gauge(
    'wager_pending_reference_transactions',
    'Transações aguardando a transação original (PENDING_REFERENCE).',
  );

  readonly reconciliationInconsistent = this.registry.gauge(
    'reconciliation_inconsistent_wallets',
    'Carteiras com divergência wallet × ledger na última reconciliação.',
  );

  readonly reconciliationLastRun = this.registry.gauge(
    'reconciliation_last_run_timestamp_seconds',
    'Unix timestamp da última reconciliação concluída.',
  );

  readonly processStart = this.registry.gauge(
    'process_start_time_seconds',
    'Unix timestamp de início do processo.',
  );

  constructor() {
    this.processStart.set({}, Math.floor(Date.now() / 1000));
  }
}
