import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'node',
    testTimeout: 45_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default']
  }
});
