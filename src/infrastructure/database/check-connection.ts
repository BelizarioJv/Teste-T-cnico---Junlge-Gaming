import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

async function main() {
  const orm = await MikroORM.init(config);

  try {
    const result = await orm.em
      .getConnection()
      .execute('SELECT 1 AS connected');

    console.log('Conexão com PostgreSQL OK:', result);
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error('Falha ao conectar com PostgreSQL:', error);
  process.exitCode = 1;
});
