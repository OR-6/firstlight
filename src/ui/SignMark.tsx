/** Sign marks shared by the live money's-path board and the static diagram on How it works. No client code. */
export type State = 'done' | 'wait' | 'stop' | 'idle';

/** Sign marks: done = white disc with check, waiting = yellow warning diamond, blocked = red octagon. */
export function Mark({ state }: { state: State }) {
  if (state === 'done')
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0" aria-hidden>
        <circle cx="10" cy="10" r="9" fill="#fff" />
        <path d="M6 10.4l2.8 2.8 5.4-6" fill="none" stroke="var(--color-allow)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === 'wait')
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0" aria-hidden>
        <path d="M10 .8L19.2 10 10 19.2.8 10z" fill="var(--color-hold-fill)" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M10 5.6v5.2" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <circle cx="10" cy="13.9" r="1.15" fill="#000" />
      </svg>
    );
  if (state === 'stop')
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0" aria-hidden>
        <path d="M6.3.8h7.4l5.5 5.5v7.4l-5.5 5.5H6.3L.8 13.7V6.3z" fill="var(--color-block)" stroke="#fff" strokeWidth="1.2" />
        <path d="M5.4 10h9.2" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  return <span className="block h-[18px] w-[18px] shrink-0 rounded-full border-2 border-white/45" aria-hidden />;
}
