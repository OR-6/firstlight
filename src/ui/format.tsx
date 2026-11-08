import type { RuleStatus, VerdictKind } from '@/firewall/types';

export function usd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function shortHash(h: string | null | undefined, n = 8): string {
  return h ? h.slice(0, n) : '—';
}

export function when(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  ALLOW: { label: 'Allowed', cls: 'text-allow bg-allow-wash border-allow/40' },
  REQUIRE_APPROVAL: { label: 'Needs approval', cls: 'text-hold bg-hold-wash border-hold/40' },
  BLOCK: { label: 'Blocked', cls: 'text-block bg-block-wash border-block/40' },
};

export function VerdictChip({ v, size = 'md' }: { v: VerdictKind | string | null; size?: 'md' | 'lg' }) {
  const meta = (v && VERDICT[v]) || { label: v ?? 'No verdict', cls: 'text-ink-muted bg-raised border-line' };
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-chip)] border font-semibold leading-[1.35] ${meta.cls} ${
        size === 'lg' ? 'px-2.5 py-1 text-[0.95rem]' : 'px-1.5 py-px text-[0.8rem]'
      }`}
    >
      {meta.label}
    </span>
  );
}

export type Tone = 'allow' | 'hold' | 'block' | 'muted';
const TONE: Record<Tone, string> = {
  allow: 'text-allow bg-allow-wash border-allow/40',
  hold: 'text-hold bg-hold-wash border-hold/40',
  block: 'text-block bg-block-wash border-block/40',
  muted: 'text-ink-muted bg-raised border-line',
};
export const TONE_HEX: Record<Tone, string> = { allow: '#2eb5a4', hold: '#e3a13b', block: '#e5534b', muted: '#6b8091' };

export function StatusChip({ label, tone, size = 'md' }: { label: string; tone: Tone; size?: 'md' | 'lg' }) {
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-chip)] border font-semibold leading-[1.35] ${TONE[tone]} ${
        size === 'lg' ? 'px-2.5 py-1 text-[0.95rem]' : 'px-1.5 py-px text-[0.8rem]'
      }`}
    >
      {label}
    </span>
  );
}

type PlanLike = {
  verdict: { overall: string; items: { recipientId: string; verdict: string }[] } | null;
  approval: { decision: string } | null;
  batch: { status: string; items: { recipientId: string; status: string }[] } | null;
};

/** Where the whole plan stands now (not just what the firewall said). */
export function planStatus(p: PlanLike): { label: string; tone: Tone } {
  if (!p.verdict) return { label: 'No plan', tone: 'block' };
  if (p.verdict.overall === 'BLOCK') return { label: 'Blocked', tone: 'block' };
  if (p.batch) {
    if (p.batch.status === 'SUCCESS') return { label: 'Paid', tone: 'allow' };
    if (['FAILED', 'DENIED'].includes(p.batch.status)) return { label: 'Payout failed', tone: 'block' };
    return { label: 'Sending', tone: 'hold' };
  }
  if (p.approval) return p.approval.decision === 'approve' ? { label: 'Approved', tone: 'allow' } : { label: 'Denied', tone: 'block' };
  return p.verdict.overall === 'ALLOW' ? { label: 'Allowed', tone: 'allow' } : { label: 'Needs approval', tone: 'hold' };
}

/** Where one recipient's payment stands now. */
export function itemStatus(p: PlanLike, recipientId: string, verdict: string): { label: string; tone: Tone } {
  if (verdict === 'BLOCK' || p.verdict?.overall === 'BLOCK') return { label: 'Blocked', tone: 'block' };
  const paid = p.batch?.items.find((i) => i.recipientId === recipientId);
  if (paid) {
    if (paid.status === 'SUCCESS') return { label: 'Paid', tone: 'allow' };
    if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED'].includes(paid.status))
      return { label: paid.status.charAt(0) + paid.status.slice(1).toLowerCase(), tone: 'block' };
    if (paid.status === 'UNCLAIMED') return { label: 'Unclaimed', tone: 'hold' };
    return { label: 'Sending', tone: 'hold' };
  }
  if (p.approval) return p.approval.decision === 'approve' ? { label: 'Approved', tone: 'allow' } : { label: 'Denied', tone: 'block' };
  return verdict === 'ALLOW' ? { label: 'Allowed', tone: 'allow' } : { label: 'Needs approval', tone: 'hold' };
}

/** Rule outcome mark: shape AND colour, so it reads without colour vision. */
export function StatusMark({ s }: { s: RuleStatus }) {
  if (s === 'pass')
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-label="pass" role="img">
        <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="var(--color-allow)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (s === 'warn')
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-label="warning" role="img">
        <path d="M7 1.8l5.6 10H1.4z" fill="none" stroke="var(--color-hold)" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M7 6v2.6" stroke="var(--color-hold)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-label="block" role="img">
      <circle cx="7" cy="7" r="5.3" fill="none" stroke="var(--color-block)" strokeWidth="1.8" />
      <path d="M3.4 10.6l7.2-7.2" stroke="var(--color-block)" strokeWidth="1.8" />
    </svg>
  );
}

export const PAGER: Record<string, string> = { green: '#3fae5f', yellow: '#e8c547', orange: '#f08a4b', red: '#e5534b' };

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error' ? 'border-block/50 bg-block-wash text-[#ffc9c4]' : tone === 'ok' ? 'border-allow/40 bg-allow-wash text-[#bff0e8]' : 'border-line bg-raised text-ink-muted';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-[var(--radius-control)] border px-3 py-2 text-[0.9rem] ${cls}`}>
      {children}
    </div>
  );
}
