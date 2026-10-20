import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: process.env.INTEGRATION ? ['tests/integration/**/*.test.mjs'] : ['tests/unit/**/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
