import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';

import type { AppMetrics } from './app-metrics.js';
import { runWithRequestId } from './request-context.js';

/** Subconjunto estrutural de Request/Response do Express usado aqui. */
interface HttpRequest {
  method: string;
  originalUrl?: string;
  url: string;
  baseUrl?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;
const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Middleware HTTP:
 * - aceita/gera `X-Request-Id` e o propaga (AsyncLocalStorage) para os logs;
 * - registra `http_requests_total` e `http_request_duration_seconds`
 *   usando a rota *template* (`/wallets/:id`) para não explodir cardinalidade;
 * - emite um log de acesso estruturado por requisição.
 */
export function httpObservabilityMiddleware(metrics: AppMetrics) {
  const logger = new Logger('HTTP');

  return (req: HttpRequest, res: HttpResponse, next: () => void): void => {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();

    res.setHeader('X-Request-Id', requestId);
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      const status = res.statusCode;

      metrics.httpRequests.inc({ method: req.method, route, status: String(status) });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);

      const entry = {
        msg: 'http.request',
        method: req.method,
        route,
        path: req.originalUrl ?? req.url,
        status,
        durationMs: Math.round(seconds * 1000 * 100) / 100,
      };

      runWithRequestId(requestId, () => {
        if (status >= 500) {
          logger.error(entry);
        } else if (QUIET_ROUTES.has(route)) {
          logger.debug(entry);
        } else {
          logger.log(entry);
        }
      });
    });

    runWithRequestId(requestId, next);
  };
}
