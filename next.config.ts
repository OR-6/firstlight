import type { NextConfig } from 'next';

const config: NextConfig = {
  // Native SQLite binding must stay a runtime require on the server.
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
  // The floating dev badge would appear in screen recordings.
  devIndicators: false,
};

export default config;
