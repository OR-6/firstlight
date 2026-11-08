import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Next's flat configs bring typescript-eslint (recommended), react, react-hooks
// (v7, including the React Compiler rules), jsx-a11y, import and @next/next.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The React Compiler rules flag two patterns the UI uses on purpose and that
    // are correct without the compiler (which this app does not enable):
    // reading browser-only values (localStorage, window.location) in a mount
    // effect so server and client render the same first frame, and the
    // "latest callback" ref (ref.current = prop during render) in QuakeMap.
    // Warn instead of fail so they stay visible to whoever owns the UI.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
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
