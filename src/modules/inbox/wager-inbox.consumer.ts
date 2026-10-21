import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { exponentialBackoffMs, sleep } from '../../common/backoff.js';
import { describeError, isPermanentError } from '../../common/errors.js';
import { validatePlain } from '../../common/validation.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { InboxStatus } from '../../infrastructure/database/entities/messaging/inbox-message.entity.js';
import { SQS_CLIENT } from '../../infrastructure/sqs/sqs.module.js';
import { AppMetrics } from '../../observability/app-metrics.js';
import { runWithRequestId } from '../../observability/request-context.js';
import { CreateWagerDto } from '../wagering/dto/create-wager.dto.js';
import { WageringService } from '../wagering/wagering.service.js';
import { InboxService } from './inbox.service.js';

export type HandleResult = 'processed' | 'duplicate' | 'dead-lettered' | 'retry';

const INBOX_SOURCE = 'sqs:wager-transactions';
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60;

/**
 * Consumidor da fila de comandos de aposta.
 *
 * - Sucesso / rejeição de negócio (ex.: saldo insuficiente): a transação é
 *   persistida, o Inbox é marcado PROCESSED na mesma transação SQL e a
 *   mensagem é removida.
 * - Erro permanente (payload inválido, carteira inexistente, chave
 *   reutilizada): Inbox FAILED, mensagem enviada explicitamente à DLQ com o
 *   motivo e removida da fila principal.
 * - Erro transitório (banco fora, timeout): a mensagem NÃO é removida; a
 *   visibilidade é estendida com backoff exponencial. Ao exceder
 *   `maxReceiveCount` o próprio SQS move a mensagem para a DLQ (redrive).
 *
 * Mensagens são tratadas em sequência para preservar a ordem FIFO por
 * MessageGroupId (use o walletId como grupo ao publicar).
 */
@Injectable()
export class WagerInboxConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WagerInboxConsumer.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(WageringService) private readonly wagering: WageringService,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.sqs.consumerEnabled) {
      this.logger.log('SQS consumer desabilitado (SQS_CONSUMER_ENABLED=false).');
      return;
    }

    this.logger.log({ msg: 'sqs.consumer.started', queue: this.config.sqs.wagerQueueUrl });
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  isRunning(): boolean {
    return this.loop !== null && !this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;

    while (!signal.aborted) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.sqs.wagerQueueUrl,
            MaxNumberOfMessages: this.config.sqs.maxMessages,
            WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            // Nome antigo do mesmo parâmetro, ainda exigido por ElasticMQ/LocalStack antigos.
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: signal },
        );

        for (const message of response.Messages ?? []) {
          if (signal.aborted) {
            break; // não confirmadas voltam para a fila após o visibility timeout
          }
          await this.handle(message);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.logger.error({ msg: 'sqs.receive.failed', ...describeError(error) });
        await sleep(2000, signal);
      }
    }

    this.logger.log({ msg: 'sqs.consumer.stopped' });
  }

  /** Público para permitir testes de integração sem o loop de polling. */
  async handle(message: Message): Promise<HandleResult> {
    // Correlaciona todos os logs desta mensagem pelo MessageId.
    return runWithRequestId(`sqs:${message.MessageId ?? 'unknown'}`, async () => {
      try {
        const result = await this.handleMessage(message);
        this.metrics.sqsMessages.inc({ result });
        return result;
      } catch (error) {
        this.metrics.sqsMessages.inc({ result: 'error' });
        throw error;
      }
    });
  }

  private async handleMessage(message: Message): Promise<HandleResult> {
    const messageId = message.MessageId ?? 'unknown';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const body = message.Body ?? '';

    let payload: Record<string, unknown>;
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
      payload =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { raw: body };
    } catch {
      parsed = undefined;
      payload = { raw: body };
    }

    let inboxId: string | null = null;

    try {
      const inbox = await this.inbox.register(INBOX_SOURCE, messageId, payload);
      inboxId = inbox.id;

      if (inbox.status !== InboxStatus.RECEIVED) {
        // Já processada (ou já enviada à DLQ) numa entrega anterior.
        await this.deleteMessage(message);
        this.logger.log({ msg: 'sqs.message.duplicate', messageId, inboxStatus: inbox.status });
        return 'duplicate';
      }

      if (parsed === undefined) {
        throw new SyntaxError('Corpo da mensagem não é JSON válido.');
      }

      const dto = await validatePlain(CreateWagerDto, parsed);
      const outcome = await this.wagering.process(dto, { inboxMessageId: inbox.id });

      await this.deleteMessage(message);
      this.logger.log({
        msg: 'sqs.message.processed',
        messageId,
        transactionId: outcome.view.transactionId,
        status: outcome.status,
        replayed: outcome.replayed,
      });
      return 'processed';
    } catch (error) {
      const { code, message: reason } = describeError(error);

      if (isPermanentError(error)) {
        // Ordem importa: só marcamos FAILED depois que a DLQ aceitou a
        // mensagem. Se algo falhar no meio, a mensagem volta e o fluxo se
        // repete (a DLQ FIFO deduplica pelo MessageDeduplicationId).
        await this.sendToDlq(message, code, reason);
        if (inboxId) {
          await this.inbox.markFailed(inboxId, `${code}: ${reason}`);
        }
        await this.deleteMessage(message);
        this.logger.warn({ msg: 'sqs.message.dead_lettered', messageId, code, reason });
        return 'dead-lettered';
      }

      if (inboxId) {
        await this.inbox.recordError(inboxId, `${code}: ${reason}`).catch(() => undefined);
      }

      const delaySeconds = Math.min(
        MAX_VISIBILITY_SECONDS,
        Math.ceil(
          exponentialBackoffMs(
            receiveCount,
            this.config.sqs.retryBaseMs,
            this.config.sqs.retryMaxMs,
          ) / 1000,
        ),
      );
      await this.changeVisibility(message, delaySeconds);

      this.logger.warn({
        msg: 'sqs.message.retry',
        messageId,
        receiveCount,
        maxReceiveCount: this.config.sqs.maxReceiveCount,
        retryInSeconds: delaySeconds,
        code,
        reason,
      });
      return 'retry';
    }
  }

  private async deleteMessage(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.sqs.wagerQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.sqs.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // Sem a extensão, a mensagem volta no visibility timeout padrão da fila.
      this.logger.warn({ msg: 'sqs.visibility.failed', ...describeError(error) });
    }
  }

  private async sendToDlq(message: Message, code: string, reason: string): Promise<void> {
    const messageId = message.MessageId ?? 'unknown';

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.sqs.wagerDlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: messageId.slice(0, 128),
        MessageAttributes: {
          originalMessageId: { DataType: 'String', StringValue: messageId },
          errorCode: { DataType: 'String', StringValue: code.slice(0, 256) },
          errorMessage: { DataType: 'String', StringValue: reason.slice(0, 1024) || '-' },
        },
      }),
    );
  }
}
