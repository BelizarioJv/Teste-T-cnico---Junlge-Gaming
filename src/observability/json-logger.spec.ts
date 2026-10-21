import { describe, expect, it } from 'vitest';

import { JsonLogger } from './json-logger.js';
import { runWithRequestId } from './request-context.js';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('emite uma linha JSON com campos promovidos e contexto do Nest', () => {
    const { logger, lines } = capture();

    logger.log({ msg: 'wager.processed', walletId: 'w1', status: 'PROCESSED' }, 'WageringService');

    expect(lines).toEqual([
      {
        time: '2026-10-20T00:00:00.000Z',
        level: 'info',
        service: 'wagering-processor',
        context: 'WageringService',
        msg: 'wager.processed',
        walletId: 'w1',
        status: 'PROCESSED',
      },
    ]);
  });

  it('inclui o requestId do contexto assíncrono', async () => {
    const { logger, lines } = capture();

    await runWithRequestId('req-123', async () => {
      await Promise.resolve();
      logger.warn('algo estranho');
    });

    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'algo estranho', requestId: 'req-123' });
  });

  it('serializa erros e stack no formato do Nest', () => {
    const { logger, lines } = capture();

    logger.error('falhou', 'Error: x\n    at y', 'ExceptionsHandler');
    logger.error(new TypeError('boom'));

    expect(lines[0]).toMatchObject({ level: 'error', msg: 'falhou', context: 'ExceptionsHandler' });
    expect(lines[0].stack).toContain('at y');
    expect(lines[1]).toMatchObject({ msg: 'boom', errorName: 'TypeError' });
  });

  it('respeita o nível mínimo', () => {
    const { logger, lines } = capture('warn');

    logger.debug('d');
    logger.log('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('não quebra com referências circulares nem bigint', () => {
    const { logger, lines } = capture();
    const payload: Record<string, unknown> = { msg: 'c', big: 10n };
    payload.self = payload;

    logger.log(payload);

    expect(lines[0]).toMatchObject({ msg: 'c', big: '10', self: { self: '[Circular]' } });
  });
});
