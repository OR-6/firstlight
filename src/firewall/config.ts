import type { FirewallConfig } from './types';

/** Defaults a human operator signs off on. See docs/decisions.md for why each value was chosen. */
export function defaultFirewallConfig(): FirewallConfig {
  return {
    tierAmountsCents: { A: 120_00, B: 80_00, C: 40_00 },
    tierMaxDistanceKm: { A: 50, B: 150, C: 300 },
    // M7.5+ uses the full bands; smaller quakes reach less far. Demo values (D102).
    bandScaleByMagnitude: [
      { minMagnitude: 7.5, factor: 1 },
      { minMagnitude: 6.5, factor: 0.6 },
      { minMagnitude: 0, factor: 0.35 },
    ],
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
      en: 'Earthquake relief via {partner}: {amount}. No action needed. Questions or not received? Call {helpline}. We never ask for a password, code or fee. (SANDBOX)',
      es: 'Ayuda por el terremoto de {partner}: {amount}. No tiene que hacer nada. ¿Dudas o no llegó? Llame al {helpline}. Nunca pedimos contraseñas, códigos ni pagos. (SANDBOX)',
      ne: '{partner} मार्फत भूकम्प राहत: {amount}। केही गर्नु पर्दैन। प्रश्न वा नआएमा {helpline} मा फोन गर्नुहोस्। हामी पासवर्ड, कोड वा शुल्क माग्दैनौं। (SANDBOX)',
      id: 'Bantuan gempa dari {partner}: {amount}. Tak perlu berbuat apa pun. Ada pertanyaan/belum masuk? Hubungi {helpline}. Kami tak meminta kata sandi, kode, atau biaya. (SANDBOX)',
      ja: '{partner}より地震支援金 {amount}。手続き不要。質問・未着は {helpline} へ。パスワード・コード・手数料は求めません。(SANDBOX)',
      tr: '{partner} aracılığıyla deprem yardımı: {amount}. Bir şey yapmanız gerekmez. Soru veya ulaşmadıysa: {helpline}. Şifre, kod veya ücret istemeyiz. (SANDBOX)',
    },
    // The field partner who enrolled the households: named in every note so the message is
    // recognisable and there is a way to report non-receipt or complain. Synthetic for the demo.
    fieldPartner: { name: 'Ayuda Local Herrera (demo)', helpLine: '+507 6000-0000' },
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
