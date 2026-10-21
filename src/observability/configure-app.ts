import { ConsoleLogger, type INestApplication, type LoggerService } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.js';
import { AppMetrics } from './app-metrics.js';
import { httpObservabilityMiddleware } from './http-observability.js';
import { JsonLogger } from './json-logger.js';

export function createLogger(config: AppConfig): LoggerService {
  if (config.log.format === 'pretty') {
    const levels = {
      debug: ['debug', 'verbose', 'log', 'warn', 'error', 'fatal'],
      info: ['log', 'warn', 'error', 'fatal'],
      warn: ['warn', 'error', 'fatal'],
      error: ['error', 'fatal'],
    } as const;
    return new ConsoleLogger('App', { logLevels: [...levels[config.log.level]] });
  }

  return new JsonLogger({ level: config.log.level });
}

/**
 * Configuração HTTP compartilhada entre `main.ts` e os testes de integração,
 * para que ambos exercitem exatamente o mesmo pipeline.
 */
export function configureApp(app: INestApplication): void {
  app.use(httpObservabilityMiddleware(app.get(AppMetrics)));
}
