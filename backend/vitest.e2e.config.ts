import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['node_modules/**'],
    hookTimeout: 60000,
    testTimeout: 60000,
    pool: 'forks', // Use child processes instead of worker threads for Playwright thread-safety
  },
});
