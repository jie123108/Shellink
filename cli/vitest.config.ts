import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/progress.ts', 'src/upgrade.ts'],
      thresholds: {
        lines: 98,
        statements: 98,
        functions: 97,
        branches: 90,
      },
    },
  },
})
