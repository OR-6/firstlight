import type { FirewallConfig } from './types';

/** Defaults a human operator signs off on. See docs/decisions.md for why each value was chosen. */
export function defaultFirewallConfig(): FirewallConfig {
  return {
    tierAmountsCents: { A: 120_00, B: 80_00, C: 40_00 },
    tierMaxDistanceKm: { A: 50, B: 150, C: 300 },
    vulnerabilityUpliftFlags: ['sole_caregiver', 'mobility_impaired', 'chronic_illness', 'elderly_living_alone'],
    minRegistrationLeadHours: 72,
    perRecipientEventCapCents: 150_00,
    perRecipientRollingCapCents: 150_00,
    rollingWindowDays: 90,
    eventCapCents: 1_500_00,
    poolSoftFraction: 0.6,
    approvalThresholdCents: 300_00,
    maxBatchesPerHour: 3,
    killSwitch: false,
    trigger: {
      minMagnitude: 6.0,
      minPagerAlert: 'orange',
      maxMagDelta: 0.5,
      maxEpicentreDistanceKm: 50,
      maxOriginTimeDeltaSec: 120,
      minAgreeingSources: 2,
    },
    sameDisaster: { radiusKm: 100, windowHours: 48 },
    maxNoteChars: 200,
    fallbackNote: 'Firstlight emergency relief payment (SANDBOX test). No action is needed.',
    // Max 200 characters each (PayPal Payouts note limit, enforced in src/paypal/payouts.ts).
    payoutNotes: {
      en: 'Firstlight earthquake relief: {amount}. No action needed. Questions: your local relief partner. We never ask for a password, code or fee. (SANDBOX)',
      es: 'Ayuda de Firstlight por el terremoto: {amount}. No tiene que hacer nada. Dudas: su organización local de ayuda. Nunca pedimos contraseñas, códigos ni pagos. (SANDBOX)',
      ne: 'भूकम्प राहत Firstlight: {amount}। केही गर्नु पर्दैन। प्रश्न भए स्थानीय राहत साझेदारलाई सोध्नुहोस्। हामी कहिल्यै पासवर्ड, कोड वा शुल्क माग्दैनौं। (SANDBOX)',
      id: 'Bantuan gempa Firstlight: {amount}. Tidak perlu melakukan apa pun. Pertanyaan: mitra bantuan setempat. Kami tidak pernah meminta kata sandi, kode, atau biaya. (SANDBOX)',
      ja: 'Firstlight 地震支援金 {amount}。手続きは不要です。ご質問は地域の支援団体へ。パスワード・コード・手数料を求めることはありません。(SANDBOX)',
      tr: 'Firstlight deprem yardımı: {amount}. Bir şey yapmanız gerekmez. Sorular: yerel yardım ortağınız. Asla şifre, kod veya ücret istemeyiz. (SANDBOX)',
    },
  };
}

type Env = Record<string, string | undefined>;

/**
 * Overlay the env-configurable values (SPEC §15) on the defaults.
 * Pure: the caller passes the env object. Invalid values throw rather than
 * silently falling back, so a typo can't widen a cap.
 */
export function firewallConfigFromEnv(env: Env, base: FirewallConfig = defaultFirewallConfig()): FirewallConfig {
  const cents = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key}: ${JSON.stringify(raw)}`);
    return Math.round(n * 100);
  };
  const capCents = cents('PER_RECIPIENT_CAP_USD', base.perRecipientEventCapCents);
  const config: FirewallConfig = {
    ...base,
    tierAmountsCents: {
      A: cents('TIER_A_USD', base.tierAmountsCents.A),
      B: cents('TIER_B_USD', base.tierAmountsCents.B),
      C: cents('TIER_C_USD', base.tierAmountsCents.C),
    },
    perRecipientEventCapCents: capCents,
    perRecipientRollingCapCents: capCents,
    eventCapCents: cents('EVENT_CAP_USD', base.eventCapCents),
    approvalThresholdCents: cents('APPROVAL_THRESHOLD_USD', base.approvalThresholdCents),
    killSwitch: env.FIREWALL_KILL_SWITCH === '1' || env.FIREWALL_KILL_SWITCH === 'true' || base.killSwitch,
  };
  const t = config.tierAmountsCents;
  if (!(t.A >= t.B && t.B >= t.C)) throw new Error('Tier amounts must satisfy A ≥ B ≥ C');
  return config;
}
