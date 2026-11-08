/**
 * The decision panel (approve or deny, or send the payouts) sits below the
 * households table. These helpers bring it into view from the money's-path
 * board, the Try-it guide, and after a run finishes.
 */
export const DECISION_ID = 'decision';

/** Scroll the decision panel into view (instantly if the reader prefers reduced motion) and focus its first field or button. */
export function goToDecision(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(DECISION_ID);
  if (!el) return false;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const first = el.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])');
  first?.focus({ preventScroll: true });
  return true;
}
