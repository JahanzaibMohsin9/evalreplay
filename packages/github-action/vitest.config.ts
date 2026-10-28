import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // core's source, so tests run before core is built
    alias: { '@evalreplay/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    name: 'github-action',
    include: ['src/**/*.test.ts'],
  },
});
