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
  ALLOW: { label: 'Allowed', cls: 'text-white bg-allow border-allow' },
  REQUIRE_APPROVAL: { label: 'Needs approval', cls: 'text-black bg-hold-fill border-[#c99700]' },
  BLOCK: { label: 'Blocked', cls: 'text-white bg-block border-block' },
};

export function VerdictChip({ v, size = 'md' }: { v: VerdictKind | string | null; size?: 'md' | 'lg' }) {
  const meta = (v && VERDICT[v]) || { label: v ?? 'No verdict', cls: 'text-ink-muted bg-panel border-line' };
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
  allow: 'text-white bg-allow border-allow',
  hold: 'text-black bg-hold-fill border-[#c99700]',
  block: 'text-white bg-block border-block',
  muted: 'text-ink-muted bg-panel border-line',
};
export const TONE_HEX: Record<Tone, string> = { allow: '#0b6e4f', hold: '#ffc72c', block: '#c8102e', muted: '#8e9692' };

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

/** Rule outcome mark, drawn as the matching sign shape so it reads without colour vision. */
export function StatusMark({ s }: { s: RuleStatus }) {
  if (s === 'pass')
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-label="pass" role="img">
        <circle cx="8" cy="8" r="7.5" fill="var(--color-allow)" />
        <path d="M4.5 8.3l2.3 2.3 4.7-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (s === 'warn')
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-label="warning" role="img">
        <path d="M8 .7L15.3 8 8 15.3.7 8z" fill="var(--color-hold-fill)" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
        <path d="M8 4.6v4.2" stroke="#000" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="8" cy="11.1" r="0.95" fill="#000" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="block" role="img">
      <path d="M5.1.7h5.8l4.4 4.4v5.8l-4.4 4.4H5.1L.7 10.9V5.1z" fill="var(--color-block)" />
      <path d="M4.3 8h7.4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** USGS PAGER alert colours. */
export const PAGER: Record<string, string> = { green: '#00a651', yellow: '#ffe800', orange: '#ff8c00', red: '#e60000' };

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error' ? 'border-block bg-block-wash text-[#7d0a1c]' : tone === 'ok' ? 'border-allow bg-allow-wash text-[#064a35]' : 'border-line bg-raised text-ink-muted';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-[var(--radius-control)] border px-3 py-2 text-[0.9rem] ${cls}`}>
      {children}
    </div>
  );
}
