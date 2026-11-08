'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { StateView } from '@/server/views';
import { LiveProvider, useApi, useLive } from './live';
import { usd } from './format';

const NAV = [
  { href: '/', label: 'Mission control' },
  { href: '/plans', label: 'Plans' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/payouts', label: 'Payouts' },
  { href: '/redteam', label: 'Red team' },
  { href: '/audit', label: 'Audit' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <LiveProvider>
      <TopBar />
      <main className="mx-auto w-full max-w-[1500px] px-4 pb-16 pt-5 md:px-6">{children}</main>
    </LiveProvider>
  );
}

/** Wordmark: a horizon with the sun just clearing it. */
function Mark() {
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden>
      <path d="M5 13a8 8 0 0 1 16 0" fill="none" stroke="var(--color-hold)" strokeWidth="2.2" />
      <path d="M1 13.5h24" stroke="var(--color-ink)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M13 1.5v2.5M5.2 4.6l1.7 1.7M20.8 4.6l-1.7 1.7" stroke="var(--color-hold)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function TopBar() {
  const path = usePathname();
  const { connected } = useLive();
  const { data } = useApi<StateView>('/api/state');
  return (
    <header className="sticky top-0 z-[1000] border-b border-line-soft bg-ground/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-5 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Firstlight home">
          <Mark />
          <span className="text-[1.15rem] font-[800] tracking-[-0.01em]">Firstlight</span>
        </Link>
        <span
          className="hidden rounded-[var(--radius-chip)] border border-hold/70 px-2 py-0.5 text-[0.8rem] font-semibold text-hold sm:inline"
          title="Every payment goes to the PayPal sandbox. No real money moves."
        >
          Sandbox: no real money moves
        </span>
        <nav className="ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Main">
          {NAV.map((n) => {
            const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap rounded-[var(--radius-control)] px-2.5 py-1.5 text-[0.92rem] ${
                  active ? 'bg-raised font-semibold text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {n.label}
                {n.href === '/approvals' && data && data.pendingApprovals > 0 ? (
                  <span className="num ml-1.5 rounded-[var(--radius-chip)] bg-hold px-1.5 text-[0.75rem] font-bold text-[#2a1d05]">{data.pendingApprovals}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="hidden items-center gap-4 text-[0.88rem] lg:flex">
          {data ? (
            <span className="text-ink-muted">
              Pool <span className="num font-semibold text-ink">{usd(data.pool.balanceCents)}</span>
            </span>
          ) : null}
          <span className="flex items-center gap-1.5 text-ink-dim" title={connected ? 'Receiving live updates' : 'Reconnecting'}>
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-allow' : 'bg-ink-dim'}`} />
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>
      <p className="border-t border-line-soft bg-hold-wash px-4 py-1 text-center text-[0.8rem] text-hold sm:hidden">Sandbox: no real money moves</p>
    </header>
  );
}
