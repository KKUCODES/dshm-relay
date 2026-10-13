import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: { '@dsh-mobile/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
})
