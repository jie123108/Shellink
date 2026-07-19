import path from 'node:path'
import os from 'node:os'
import { defineConfig } from 'vitest/config'

const masterKey = '30616a47fe6666e88cdc2e5a8fef7d81ad6c62710d0723de5a75be2dc61fea49'
const testHome = path.join(os.tmpdir(), `shellink-vitest-home-${process.pid}`)

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    env: {
      SHELLINK_MASTER_KEY: masterKey,
      SHELLINK_TOKEN: 'test-token',
      SHELLINK_SILENCE_MS: '150',
      SHELLINK_EXEC_TIMEOUT_MS: '15000',
      SHELLINK_TRANSFER_TIMEOUT_MS: '30000',
      SHELLINK_EDIT_TIMEOUT_MS: '30000',
      SHELLINK_SSH_READY_TIMEOUT_MS: '3000',
      SHELLINK_HOME: testHome,
      SHELLINK_DB: path.join(testHome, 'shellink.db'),
      SHELLINK_PORT: '0',
      SHELLINK_HOST: '127.0.0.1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/core/types.ts'],
      thresholds: {
        lines: 98,
        statements: 98,
        functions: 97,
        branches: 90,
      },
    },
  },
})
