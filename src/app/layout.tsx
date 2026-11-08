import type { Metadata } from 'next';
import { Overpass } from 'next/font/google';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import { Shell } from '@/ui/Shell';

// Overpass: open-source descendant of the US highway-sign face. One family, many weights.
const overpass = Overpass({ subsets: ['latin', 'latin-ext'], variable: '--font-overpass', display: 'swap' });

const SITE_URL = 'https://firstlight.onrender.com';
const SHARE_TITLE = 'Firstlight: earthquake relief cash in minutes';
const SHARE_DESCRIPTION =
  'Earthquake relief cash in minutes, no application needed. An AI agent drafts the payouts, a deterministic payment firewall checks them, and PayPal sends them. PayPal sandbox demo; no real money moves.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Firstlight | Mission control', template: '%s | Firstlight' },
  description: SHARE_DESCRIPTION,
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Firstlight',
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    locale: 'en',
  },
  twitter: {
    card: 'summary_large_image',
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={overpass.variable}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
