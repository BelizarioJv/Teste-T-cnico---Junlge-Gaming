import { Inject, Injectable } from '@nestjs/common';
import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';

import {
  InboxMessage,
  InboxStatus,
} from '../../infrastructure/database/entities/messaging/inbox-message.entity.js';

@Injectable()
export class InboxService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /**
   * Registra a mensagem (ou recupera o registro existente) e incrementa o
   * contador de tentativas. Seguro sob concorrência: a UNIQUE
   * (source, message_id) decide quem cria o registro.
   */
  async register(
    source: string,
    messageId: string,
    payload: Record<string, unknown>,
  ): Promise<InboxMessage> {
    const em = this.orm.em.fork();
    const existing = await em.findOne(InboxMessage, { source, messageId });

    if (existing) {
      if (existing.status === InboxStatus.RECEIVED) {
        existing.attempts += 1;
        await em.flush();
      }
      return existing;
    }

    const inbox = new InboxMessage();
    inbox.source = source;
    inbox.messageId = messageId;
    inbox.status = InboxStatus.RECEIVED;
    inbox.payload = payload;
    inbox.attempts = 1;
    inbox.lastError = null;
    inbox.transactionId = null;
    inbox.receivedAt = new Date();
    inbox.processedAt = null;

    try {
      em.persist(inbox);
      await em.flush();
      return inbox;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        return this.orm.em
          .fork()
          .findOneOrFail(InboxMessage, { source, messageId });
      }
      throw error;
    }
  }

  async markFailed(inboxId: string, reason: string): Promise<void> {
    await this.orm.em.fork().nativeUpdate(
      InboxMessage,
      { id: inboxId, status: InboxStatus.RECEIVED },
      { status: InboxStatus.FAILED, lastError: reason, processedAt: new Date() },
    );
  }

  async recordError(inboxId: string, reason: string): Promise<void> {
    await this.orm.em
      .fork()
      .nativeUpdate(
        InboxMessage,
        { id: inboxId, status: InboxStatus.RECEIVED },
        { lastError: reason },
      );
  }
}
