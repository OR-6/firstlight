import type { Metadata } from 'next';
import { Overpass } from 'next/font/google';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import { Shell } from '@/ui/Shell';

// Overpass: open-source descendant of the US highway-sign face. One family, many weights.
const overpass = Overpass({ subsets: ['latin', 'latin-ext'], variable: '--font-overpass', display: 'swap' });

export const metadata: Metadata = {
  title: 'Firstlight (sandbox)',
  description: 'Disaster-relief payouts proposed by an AI agent and checked by a payment firewall. PayPal sandbox only; no real money moves.',
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
