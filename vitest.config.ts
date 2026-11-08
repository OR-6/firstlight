import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Same as tsconfig "paths", so tests can import route handlers directly.
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      // Next resolves this to an empty module on the server; outside Next the default export throws.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
  },
});
