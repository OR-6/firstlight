import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Agents',
  description: 'How AI agents find Firstlight and donate over MCP, under an allowance a person sets. PayPal sandbox only.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
