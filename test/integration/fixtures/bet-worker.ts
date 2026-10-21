/**
 * Processo worker independente (pool de conexões próprio), usado pelo teste
 * de múltiplos processos. Processa as chaves recebidas em paralelo e imprime
 * o resultado em JSON na última linha do stdout.
 *
 * Env: WALLET_ID, PLAYER_ID, AMOUNT, KEYS (separadas por vírgula).
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { ConfigModule } from '../../../src/config/config.module.js';
import { WagerOperation } from '../../../src/domain/wagering/wager.types.js';
import config from '../../../src/infrastructure/database/mikro-orm.config.js';
import { SqsModule } from '../../../src/infrastructure/sqs/sqs.module.js';
import { WageringModule } from '../../../src/modules/wagering/wagering.module.js';
import { WageringService } from '../../../src/modules/wagering/wagering.service.js';
import { ObservabilityModule } from '../../../src/observability/observability.module.js';

@Module({
  imports: [ConfigModule, MikroOrmModule.forRoot(config), ObservabilityModule, SqsModule, WageringModule],
})
class BetWorkerModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BetWorkerModule, { logger: false });
  const wagering = app.get(WageringService);
  const keys = (process.env.KEYS ?? '').split(',').filter(Boolean);

  const results = await Promise.all(
    keys.map(async (idempotencyKey) => {
      try {
        const outcome = await wagering.process({
          walletId: process.env.WALLET_ID as string,
          playerId: process.env.PLAYER_ID as string,
          operation: WagerOperation.BET,
          amount: process.env.AMOUNT ?? '1.00',
          currency: 'BRL',
          idempotencyKey,
        });
        return {
          key: idempotencyKey,
          pid: process.pid,
          transactionId: outcome.view.transactionId,
          status: outcome.status,
          replayed: outcome.replayed,
        };
      } catch (error) {
        return { key: idempotencyKey, pid: process.pid, error: String(error) };
      }
    }),
  );

  await app.close();
  process.stdout.write(`\n${JSON.stringify(results)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
