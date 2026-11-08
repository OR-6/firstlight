import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Red team' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
