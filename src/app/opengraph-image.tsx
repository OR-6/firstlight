import { ImageResponse } from 'next/og';

/**
 * Social preview card, drawn with the design tokens (DESIGN.md): concrete-grey
 * ground, black lettering, and the money's-path board as a green guide sign
 * with a white inset border. Uses the default font, so nothing is fetched.
 */
export const alt = 'Firstlight: earthquake relief cash in minutes, no application needed';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const GROUND = '#e5e9e7';
const INK = '#000000';
const MUTED = '#3f4744';
const ALLOW = '#0b6e4f';
const HOLD_FILL = '#ffc72c';

const STAGES = ['Confirmed', 'Agent drafts', 'Firewall checks', 'Person approves', 'PayPal pays'];

/** One line, set by hand so the break falls where it reads best. */
function Line({ text }: { text: string }) {
  return <div style={{ display: 'flex', whiteSpace: 'nowrap' }}>{text}</div>;
}

export function renderSocialCard() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: GROUND, padding: '56px 64px', color: INK }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <svg width="78" height="54" viewBox="0 0 26 18">
            <path d="M5 13a8 8 0 0 1 16 0z" fill={HOLD_FILL} stroke={INK} strokeWidth="1.6" />
            <path d="M1 13.5h24" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
            <path d="M13 1.2v2.6M5 4.4l1.8 1.8M21 4.4l-1.8 1.8" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <div style={{ display: 'flex', fontSize: 44, fontWeight: 800 }}>Firstlight</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40, fontSize: 66, fontWeight: 800, lineHeight: 1.1 }}>
          <Line text="Earthquake relief cash in minutes," />
          <Line text="no application needed." />
        </div>
        <div style={{ display: 'flex', marginTop: 20, fontSize: 27, color: MUTED }}>
          <Line text="An AI agent drafts payouts, a fixed-rule firewall checks them, PayPal sends them." />
        </div>
        <div style={{ display: 'flex', marginTop: 'auto', background: ALLOW, borderRadius: 10, padding: 5 }}>
          <div style={{ display: 'flex', flex: 1, border: '3px solid #ffffff', borderRadius: 7, padding: '20px 24px', justifyContent: 'space-between' }}>
            {STAGES.map((s) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#ffffff', fontSize: 23, fontWeight: 700 }}>
                <svg width="26" height="26" viewBox="0 0 20 20">
                  <circle cx="10" cy="10" r="9" fill="#ffffff" />
                  <path d="M6 10.4l2.8 2.8 5.4-6" fill="none" stroke={ALLOW} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div style={{ display: 'flex' }}>{s}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}

export default function OpengraphImage() {
  return renderSocialCard();
}
