'use client';

import { useEffect, useRef } from 'react';
import type { RuleId } from '@/firewall/types';
import { StatusMark, VerdictChip, usd } from './format';
import type { PlanRow } from './PlanGrid';

/** What each rule checks, in plain words (SPEC §5.4). */
export const RULE_NAMES: Record<RuleId, string> = {
  R1: 'Registered and verified before the quake',
  R2: 'Tier allowed by distance',
  R3: 'Amount from the tier table',
  R4: 'Per-person limits',
  R5: 'Event budget',
  R6: 'Not already paid for this disaster',
  R7: 'Payout rate and kill switch',
  R8: 'Earthquake confirmed by two sources',
  R9: 'Plan integrity and warnings',
  R10: 'Needs a human?',
};

export function RuleDrawer({ row, onClose }: { row: PlanRow | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!row) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  if (!row) return null;
  return (
    <div className="fixed inset-0 z-[2000] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <button className="absolute inset-0 bg-black/35" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <aside className="relative flex h-full w-full max-w-[560px] flex-col border-l border-line bg-panel shadow-[-16px_0_40px_rgb(0_0_0/0.18)] motion-safe:animate-[slidein_160ms_ease-out]">
        <header className="flex items-start gap-4 border-b border-line-soft px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 id="drawer-title" className="text-[1.3rem] font-[800] leading-tight">
              {row.recipientId} <span className="font-normal text-ink-muted">{row.town}</span>
            </h2>
            <p className="num mt-1 text-ink-muted">
              {row.distanceKm != null ? `${Math.round(row.distanceKm)} km from the epicentre. ` : ''}
              Asked for tier {row.requestedTier}, allowed {row.allowedTier ?? 'none'}.
            </p>
          </div>
          <button ref={closeRef} className="btn h-8 px-2.5" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="flex items-center gap-4 border-b border-line-soft px-6 py-4">
          <span className="text-[0.85rem] text-ink-muted">Firewall verdict</span>
          <VerdictChip v={row.verdict} size="lg" />
          <span className="num text-[1.4rem] font-[800]">{usd(row.amountCents)}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <h3 className="mb-2 text-[0.95rem] font-bold">Firewall checks</h3>
          <ol className="divide-y divide-line-soft">
            {row.ruleTrace.map((r, i) => (
              <li key={`${r.id}-${i}`} className="grid grid-cols-[2.4rem_1.2rem_1fr] gap-x-2 py-2.5">
                <span className="num pt-0.5 text-[0.85rem] font-bold text-ink-muted">{r.id}</span>
                <span className="pt-1">
                  <StatusMark s={r.status} />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.93rem] font-semibold">
                    {RULE_NAMES[r.id]}
                    {r.scope === 'plan' ? <span className="ml-2 text-[0.78rem] font-normal text-ink-dim">whole plan</span> : null}
                  </p>
                  <p className="num break-words text-[0.86rem] text-ink-muted">{r.detail}</p>
                  <p className="text-[0.75rem] text-ink-dim">{r.reasonCode}</p>
                </div>
              </li>
            ))}
          </ol>
          <h3 className="mb-1 mt-6 text-[0.95rem] font-bold">Note the recipient will see</h3>
          <p className="rounded-[var(--radius-control)] border border-line-soft bg-ground px-3 py-2 text-[0.95rem]" lang={row.locale || undefined}>
            {row.note}
          </p>
        </div>
      </aside>
    </div>
  );
}
