import type { LoggerService } from '@nestjs/common';

import { currentRequestId } from './request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  level?: LogLevel;
  service?: string;
  /** Destino das linhas (padrão: stdout). Injetável para testes. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Logger estruturado: uma linha JSON por evento, pronta para Loki,
 * CloudWatch, Datadog, etc.
 *
 * Campos fixos: time, level, service, context, msg, requestId (quando houver).
 * Quando a mensagem é um objeto (`logger.log({ msg, walletId, ... })`), seus
 * campos são promovidos ao nível superior — é assim que todo o código do
 * projeto loga.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;
  private readonly service: string;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: JsonLoggerOptions = {}) {
    this.threshold = SEVERITY[options.level ?? 'info'];
    this.service = options.service ?? 'wagering-processor';
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.emit('info', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.emit('warn', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.emit('error', message, optional);
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.emit('error', message, optional, { fatal: true });
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.emit('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.emit('debug', message, optional);
  }

  private emit(
    level: LogLevel,
    message: unknown,
    optional: unknown[],
    extra: Record<string, unknown> = {},
  ): void {
    if (SEVERITY[level] < this.threshold) {
      return;
    }

    // Convenção do Nest: o último parâmetro string é o contexto; em
    // error(), um parâmetro string anterior é o stack.
    const params = [...optional];
    const context =
      params.length > 0 && typeof params[params.length - 1] === 'string'
        ? (params.pop() as string)
        : undefined;
    const stack =
      level === 'error' && typeof params[0] === 'string' ? (params.shift() as string) : undefined;

    const entry: Record<string, unknown> = {
      time: this.now().toISOString(),
      level,
      service: this.service,
    };

    if (context) {
      entry.context = context;
    }

    const requestId = currentRequestId();
    if (requestId) {
      entry.requestId = requestId;
    }

    Object.assign(entry, extra, normalizeMessage(message));

    if (stack && entry.stack === undefined) {
      entry.stack = stack;
    }

    if (params.length > 0) {
      entry.extra = params.map(serializeValue);
    }

    this.write(safeStringify(entry));
  }
}

function normalizeMessage(message: unknown): Record<string, unknown> {
  if (message instanceof Error) {
    return { msg: message.message, errorName: message.name, stack: message.stack };
  }

  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const fields = Object.fromEntries(
      Object.entries(message as Record<string, unknown>).map(([k, v]) => [k, serializeValue(v)]),
    );
    if (fields.msg === undefined) {
      fields.msg = 'log';
    }
    return fields;
  }

  return { msg: typeof message === 'string' ? message : safeStringify(message) };
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') {
      return v.toString();
    }
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) {
        return '[Circular]';
      }
      seen.add(v);
    }
    return v;
  });
}
