import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Next's flat configs bring typescript-eslint (recommended), react, react-hooks
// (v7, including the React Compiler rules), jsx-a11y, import and @next/next.
// Every rule runs at its default level, and `npm run lint` allows no warnings.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Tests poke malformed shapes into untyped fixture JSON (e.g. USGS features).
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Tool config files export an anonymous object by convention.
    files: ['*.config.{js,mjs,ts}'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
  globalIgnores(['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', '.claude/**', 'video/**', 'data/**']),
]);
