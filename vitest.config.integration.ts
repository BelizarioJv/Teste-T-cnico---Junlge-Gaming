import { defineConfig } from 'vitest/config';

// Testes de integração: exigem PostgreSQL com migrations aplicadas
// (docker compose up -d && bun run migration:up).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    // Os arquivos compartilham o mesmo banco; rodar em série evita disputa
    // entre arquivos (a concorrência é testada DENTRO de cada teste).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
