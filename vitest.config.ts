import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['contracts/**', 'node_modules/**', 'dist/**'],
  },
});
