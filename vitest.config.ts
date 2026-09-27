import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/kimi-code', 'apps/vscode'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
      // Measured baseline (merged over the library packages, `pnpm run
      // test:coverage --project …`): lines 90.4 / statements 88.5 /
      // functions 89.4 / branches 81.9. These floors sit a little below that
      // measurement so the gate is enforced without flaking on noise; raise
      // them as coverage improves.
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 80,
      },
    },
  },
});
