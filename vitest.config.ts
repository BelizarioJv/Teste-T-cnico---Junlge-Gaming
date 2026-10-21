import { defineConfig } from 'vitest/config';

// Testes unitários: não dependem de banco nem de fila.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
  },
});
