import type { EntityManager } from '@mikro-orm/core';

import { OutboxEvent } from '../../infrastructure/database/entities/messaging/outbox-event.entity.js';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /** Chave de ordenação (MessageGroupId). Use o id da carteira. */
  partitionKey: string;
  payload: Record<string, unknown>;
}

/**
 * Registra um evento no Outbox. Deve ser chamado com o mesmo `em` da
 * transação que altera o estado, para que evento e estado sejam gravados
 * atomicamente (ou nenhum dos dois).
 */
export function enqueueOutboxEvent(
  em: EntityManager,
  input: OutboxEventInput,
): OutboxEvent {
  const now = new Date();
  const event = new OutboxEvent();

  event.aggregateType = input.aggregateType;
  event.aggregateId = input.aggregateId;
  event.eventType = input.eventType;
  event.partitionKey = input.partitionKey;
  event.payload = {
    ...input.payload,
    eventId: event.id,
    eventType: input.eventType,
    occurredAt: now.toISOString(),
  };
  event.nextAttemptAt = now;
  event.createdAt = now;

  em.persist(event);

  return event;
}
