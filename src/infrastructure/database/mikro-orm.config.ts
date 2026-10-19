import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';

import { Wallet } from './entities/wallet.entity.js';
import { LedgerEntry } from './entities/ledger-entry.entity.js';

export default defineConfig({
  metadataProvider: TsMorphMetadataProvider,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5433),
  dbName: process.env.DB_NAME ?? 'wagering_db',
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',

  entities: [Wallet, LedgerEntry],

  extensions: [Migrator],

  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
  },
});
