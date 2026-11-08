'use client';

import { useEffect, useRef } from 'react';
import { defaultFirewallConfig } from '@/firewall/config';
import { payoutNoteFor } from '@/firewall/notes';
import type { RuleId } from '@/firewall/types';
import { Notice, StatusMark, VerdictChip, usd } from './format';
import type { PlanRow } from './PlanGrid';
import { draftLang, findingTitle, noteLang, plainRule, verdictReasons } from './plain';

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
  R12: 'Nobody eligible left out or underpaid',
};

/** A finding's heading: its own title where a rule returns several findings (R9, R12), else the rule's name. */
export function ruleTitle(r: { id: string; reasonCode: string }): string {
  return findingTitle(r.reasonCode) ?? RULE_NAMES[r.id as RuleId] ?? r.id;
}

/** Why the drawer's row no longer matches the screen behind it. */
export type DrawerStale = 'reset' | 'replaced' | null;

export function RuleDrawer({ row, stale = null, onClose }: { row: PlanRow | null; stale?: DrawerStale; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = row !== null;
  useEffect(() => {
    if (!open) return;
    // Remember what opened the drawer (a grid cell, a card, a map marker) and go back to it on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, onClose]);

  if (!row) return null;
  const reasons = verdictReasons(row);
  const lang = noteLang(row, row.locale);
  // A note in another language is shown with its English version, for reviewers who don't read it.
  const english = lang && lang !== 'en' && row.amountCents > 0 ? payoutNoteFor('en', row.amountCents, defaultFirewallConfig()) : null;
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

        {stale ? (
          <div className="border-b border-line-soft px-6 py-3">
            <Notice>
              {stale === 'reset'
                ? 'This plan was reset. The checks below belong to a plan that no longer exists, and nothing in it can be paid.'
                : 'A new assessment replaced this plan. The checks below are from the old plan; close this and select the household again.'}
            </Notice>
          </div>
        ) : null}
        <div className="border-b border-line-soft px-6 py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[0.85rem] text-ink-muted">Firewall verdict</span>
            <VerdictChip v={row.verdict} size="lg" />
            <span className="num text-[1.4rem] font-[800]">{usd(row.amountCents)}</span>
          </div>
          <ul className="mt-2.5 space-y-1 text-[0.98rem] leading-snug">
            {reasons.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <h3 className="mb-2 text-[0.95rem] font-bold">Firewall checks</h3>
          <ol className="divide-y divide-line-soft">
            {row.ruleTrace.map((r, i) => (
              <li key={`${r.id}-${i}`} className="grid grid-cols-[1.2rem_1fr] gap-x-2.5 py-2.5">
                <span className="pt-1">
                  <StatusMark s={r.status} />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.93rem] font-semibold">
                    <span className="num mr-1.5 text-ink-muted" title={`${r.reasonCode}: ${r.detail}`}>
                      {r.id}
                    </span>
                    {ruleTitle(r)}
                    {r.scope === 'plan' ? <span className="ml-2 text-[0.78rem] font-normal text-ink-dim">whole plan</span> : null}
                  </p>
                  <p className="break-words text-[0.88rem] text-ink-muted" title={r.detail}>
                    {plainRule(r)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <h3 className="mb-1 mt-6 text-[0.95rem] font-bold">Message PayPal sends</h3>
          <p className="rounded-[var(--radius-control)] border border-line-soft bg-ground px-3 py-2 text-[0.95rem]" lang={lang}>
            {row.note}
          </p>
          {english ? (
            <p className="mt-1.5 text-[0.88rem] text-ink-muted">
              <span className="font-semibold">In English:</span> <span lang="en">{english}</span>
            </p>
          ) : null}
          <p className="mt-1.5 text-[0.82rem] text-ink-dim">
            A fixed note in the household&apos;s language, naming the field partner and its help line. Every household gets the same one; the agent can&apos;t change it.
          </p>
          {row.agentNote ? (
            <>
              <h3 className="mb-1 mt-4 text-[0.95rem] font-bold">The agent&apos;s draft (shown to you, never sent)</h3>
              <p className="rounded-[var(--radius-control)] border border-dashed border-line px-3 py-2 text-[0.92rem] text-ink-muted" lang={draftLang(row, row.locale)}>
                {row.agentNote}
              </p>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
