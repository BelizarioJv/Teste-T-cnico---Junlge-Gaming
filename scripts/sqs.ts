/**
 * Utilitário para as filas locais, sem precisar do AWS CLI.
 *
 *   bun run sqs send '<json do comando>'   # envia para wager-transactions.fifo
 *   bun run sqs send-file comando.json     # idem, lendo de arquivo (prático no PowerShell)
 *   bun run sqs peek dlq                   # espia a DLQ sem remover as mensagens
 *   bun run sqs peek events                # espia os eventos publicados pelo Outbox
 *   bun run sqs peek wager                 # espia a fila de entrada
 *   bun run sqs stats                      # quantidade de mensagens em cada fila
 *   bun run sqs purge dlq|events|wager     # esvazia uma fila
 */
import { readFileSync } from 'node:fs';
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { loadAppConfig } from '../src/config/app-config.js';

const config = loadAppConfig();
const client = new SQSClient({
  region: config.sqs.region,
  endpoint: config.sqs.endpoint,
  credentials: {
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
});

const QUEUES: Record<string, string> = {
  wager: config.sqs.wagerQueueUrl,
  dlq: config.sqs.wagerDlqUrl,
  events: config.sqs.eventsQueueUrl,
};

function queueUrl(name: string | undefined): string {
  const url = name ? QUEUES[name] : undefined;
  if (!url) {
    throw new Error(`Fila desconhecida "${name}". Use: ${Object.keys(QUEUES).join(', ')}`);
  }
  return url;
}

async function send(json: string): Promise<void> {
  const body = JSON.parse(json) as Record<string, unknown>;
  const groupId = String(body.walletId ?? 'default');
  const dedupId = String(body.idempotencyKey ?? `${Date.now()}`).slice(0, 128);

  const res = await client.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.wagerQueueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
  console.log(JSON.stringify({ sent: true, messageId: res.MessageId, groupId, dedupId }, null, 2));
}

async function peek(name: string | undefined): Promise<void> {
  const res = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(name),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0, // devolve imediatamente: só observa
      MessageAttributeNames: ['All'],
      AttributeNames: ['All'],
    }),
  );

  const messages = (res.Messages ?? []).map((m) => ({
    messageId: m.MessageId,
    receiveCount: m.Attributes?.ApproximateReceiveCount,
    attributes: Object.fromEntries(
      Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue]),
    ),
    body: safeJson(m.Body ?? ''),
  }));

  console.log(JSON.stringify(messages, null, 2));
  if (messages.length === 0) {
    console.error('(nenhuma mensagem visível)');
  }
}

async function stats(): Promise<void> {
  for (const [name, url] of Object.entries(QUEUES)) {
    const res = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    console.log(
      `${name.padEnd(7)} visíveis=${res.Attributes?.ApproximateNumberOfMessages ?? '?'} ` +
        `em processamento=${res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '?'}  ${url}`,
    );
  }
}

async function purge(name: string | undefined): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl(name) }));
  console.log(`Fila ${name} esvaziada.`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case 'send':
      if (!arg) throw new Error('Informe o JSON do comando.');
      return send(arg);
    case 'send-file':
      if (!arg) throw new Error('Informe o caminho do arquivo JSON.');
      return send(readFileSync(arg, 'utf8'));
    case 'peek':
      return peek(arg);
    case 'stats':
      return stats();
    case 'purge':
      return purge(arg);
    default:
      console.log('Uso: bun run sqs <send|send-file|peek|stats|purge> [argumento]');
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.destroy());
