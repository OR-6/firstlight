'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
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
  { href: '/how-it-works', label: 'How it works' },
  { href: '/donate', label: 'Donate' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <LiveProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[2000] focus:rounded-[var(--radius-control)] focus:bg-black focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <TopBar />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] px-4 pb-16 pt-5 md:px-6">{children}</main>
    </LiveProvider>
  );
}

/** Wordmark: a horizon with the sun just clearing it. */
function Mark() {
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden>
      <path d="M5 13a8 8 0 0 1 16 0z" fill="var(--color-hold-fill)" stroke="#000" strokeWidth="1.6" />
      <path d="M1 13.5h24" stroke="#000" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13 1.2v2.6M5 4.4l1.8 1.8M21 4.4l-1.8 1.8" stroke="#000" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function NavLinks({ path, pending, onNavigate }: { path: string; pending: number; onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((n) => {
        const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center whitespace-nowrap border-b-[3px] px-2.5 py-1.5 text-[0.95rem] ${
              active ? 'border-black font-bold text-black' : 'border-transparent text-ink-muted hover:text-black'
            }`}
          >
            {n.label}
            {n.href === '/approvals' && pending > 0 ? (
              <span className="num ml-1.5 rounded-[var(--radius-chip)] bg-hold-fill px-1.5 text-[0.75rem] font-bold text-black" aria-label={`${pending} waiting`}>
                {pending}
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

function TopBar() {
  const path = usePathname();
  const { connected } = useLive();
  const { data } = useApi<StateView>('/api/state');
  const [open, setOpen] = useState(false);
  const pending = data?.pendingApprovals ?? 0;
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="sticky top-0 z-[1000] border-b border-line-soft bg-panel">
      <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-4 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Firstlight home">
          <Mark />
          <span className="text-[1.2rem] font-[800] tracking-[-0.01em]">Firstlight</span>
        </Link>
        <nav className="ml-2 hidden h-full items-stretch gap-1 lg:flex" aria-label="Main">
          <NavLinks path={path} pending={pending} />
        </nav>
        <div className="ml-auto flex items-center gap-4 text-[0.9rem]">
          {data ? (
            <span className="hidden text-ink-muted md:inline">
              Pool <span className="num font-bold text-black">{usd(data.pool.balanceCents)}</span>
            </span>
          ) : null}
          <span className="hidden items-center gap-1.5 text-ink-dim sm:flex" title={connected ? 'Receiving live updates' : 'Reconnecting'}>
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-allow' : 'bg-line'}`} />
            {connected ? 'Live' : 'Offline'}
          </span>
          <button
            className="btn h-9 lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close menu' : 'Menu'}
            {!open && pending > 0 ? <span className="num rounded-[var(--radius-chip)] bg-hold-fill px-1.5 text-[0.75rem] font-bold">{pending}</span> : null}
          </button>
        </div>
      </div>
      {open ? (
        <nav id="mobile-nav" aria-label="Main" className="flex flex-col border-t border-line-soft bg-panel px-2 py-2 lg:hidden">
          <NavLinks path={path} pending={pending} onNavigate={() => setOpen(false)} />
          {data ? (
            <p className="px-2.5 pt-2 text-[0.9rem] text-ink-muted">
              Pool <span className="num font-bold text-black">{usd(data.pool.balanceCents)}</span>
            </p>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
