/**
 * Firewall types. Everything here is plain data: the firewall receives a
 * snapshot of the world and returns a verdict. It never reads a clock, a
 * database, the network, or an LLM.
 */

export type Tier = 'A' | 'B' | 'C';
export const TIERS_HIGH_TO_LOW: readonly Tier[] = ['A', 'B', 'C'];

export type PagerAlert = 'green' | 'yellow' | 'orange' | 'red';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R12';
export type RuleStatus = 'pass' | 'warn' | 'block';
export type VerdictKind = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';

export type RuleResult = {
  id: RuleId;
  /** 'plan' rules apply to the whole plan and are copied into every item trace. */
  scope: 'item' | 'plan';
  status: RuleStatus;
  reasonCode: ReasonCode;
  detail: string;
};

export type ReasonCode =
  // R1 registry
  | 'REGISTERED_ELIGIBLE'
  | 'UNKNOWN_RECIPIENT'
  | 'RECIPIENT_UNVERIFIED'
  | 'REGISTERED_TOO_LATE'
  // R2 tier band
  | 'TIER_WITHIN_BAND'
  | 'TIER_DOWNGRADED'
  | 'OUTSIDE_MAX_RADIUS'
  // R3 amount
  | 'AMOUNT_FROM_TIER_TABLE'
  // R4 per-recipient caps
  | 'WITHIN_RECIPIENT_CAPS'
  | 'RECIPIENT_EVENT_CAP_EXCEEDED'
  | 'RECIPIENT_ROLLING_CAP_EXCEEDED'
  // R5 budget
  | 'WITHIN_BUDGET'
  | 'BUDGET_SOFT_LIMIT'
  | 'EVENT_CAP_EXCEEDED'
  | 'POOL_INSUFFICIENT'
  // R6 duplicates
  | 'FIRST_PAYOUT'
  | 'ALREADY_PAID_FOR_EVENT'
  | 'DUPLICATE_IN_PLAN'
  | 'ALREADY_PAID_FOR_SAME_DISASTER'
  // R7 velocity
  | 'WITHIN_VELOCITY'
  | 'KILL_SWITCH_ENGAGED'
  | 'VELOCITY_EXCEEDED'
  // R8 trigger
  | 'TRIGGER_CORROBORATED'
  | 'TRIGGER_THRESHOLD_NOT_MET'
  | 'TRIGGER_MAGNITUDE_ONLY'
  | 'TRIGGER_UNCORROBORATED'
  | 'TRIGGER_CORROBORATION_DEGRADED'
  | 'EVENT_IN_FUTURE'
  // R9 plan integrity / flags
  | 'PLAN_CLEAN'
  | 'PLAN_MALFORMED'
  | 'PLAN_EVENT_MISMATCH'
  | 'PLAN_UNKNOWN_FIELDS'
  | 'INJECTION_SUSPECTED'
  | 'EXCEPTION_REQUESTED'
  | 'AGENT_HOLD'
  | 'AGENT_ESCALATED'
  | 'NOTE_OK'
  | 'NOTE_REPLACED'
  // R12 coverage floor
  | 'ALL_ELIGIBLE_COVERED'
  | 'ELIGIBLE_OMITTED'
  | 'TIER_BELOW_BAND'
  | 'HOLD_ON_MET_TRIGGER'
  // R10 approval
  | 'AUTO_APPROVABLE'
  | 'OVER_APPROVAL_THRESHOLD'
  | 'WARNINGS_PRESENT'
  | 'ITEMS_BLOCKED'
  | 'NO_PAYABLE_ITEMS';

export type GeoPoint = { lat: number; lon: number };

/** The primary (USGS) event the plan is about. Times are epoch milliseconds. */
export type FirewallEvent = {
  id: string;
  /** Other network ids USGS lists for the same physical event (`ids` field). */
  aliases: string[];
  time: number;
  epicentre: GeoPoint;
  mag: number;
  alert: PagerAlert | null;
};

/** One corroborating observation of the same physical event from another source. */
export type CorroborationObservation = {
  source: string;
  /**
   * true for a genuinely independent network (e.g. EMSC). false for the
   * fallback "USGS reviewed + PAGER" signal, which is not independent.
   */
  independent: boolean;
  mag: number;
  epicentre: GeoPoint;
  time: number;
};

export type RegistryRecipient = {
  recipientId: string;
  verified: boolean;
  registeredAt: number;
  home: GeoPoint;
  locale: string;
  flags: string[];
  // NOTE: no email. The firewall never needs, and never sees, payee addresses.
};

/** Payout statuses that mean money never left the pool. */
export const NEVER_SENT_STATUSES = ['FAILED', 'BLOCKED', 'DENIED', 'CANCELED'] as const;

export type PriorPayout = {
  eventId: string;
  recipientId: string;
  amountCents: number;
  /** Epoch ms the payout was reserved. */
  at: number;
  /** Ledger status (RESERVED, PENDING, SUCCESS, UNCLAIMED, FAILED, ...). */
  status: string;
};

/** A previously paid event, used to spot the same disaster arriving under a new id. */
export type PaidEvent = {
  eventId: string;
  aliases: string[];
  time: number;
  epicentre: GeoPoint;
};

export type LedgerSnapshot = {
  poolBalanceCents: number;
  payouts: PriorPayout[];
  /** Epoch ms of each payout batch submitted (for velocity). */
  batchTimes: number[];
  paidEvents: PaidEvent[];
};

export type FirewallConfig = {
  tierAmountsCents: Record<Tier, number>;
  /** Outer edge (km, inclusive) of each tier's distance band for the strongest quakes. Beyond C → no payout. */
  tierMaxDistanceKm: Record<Tier, number>;
  /**
   * Bands shrink for smaller quakes (basis risk: an M6.0 doesn't hurt people 300 km away).
   * The first entry whose minMagnitude the event reaches sets the factor. Agreed by the programme
   * before the season, like every other value here.
   */
  bandScaleByMagnitude: { minMagnitude: number; factor: number }[];
  /** Recipients with any of these flags may receive one tier above their distance band. */
  vulnerabilityUpliftFlags: string[];
  minRegistrationLeadHours: number;
  perRecipientEventCapCents: number;
  perRecipientRollingCapCents: number;
  rollingWindowDays: number;
  eventCapCents: number;
  /** Plan totals above this fraction of the pool need a human. */
  poolSoftFraction: number;
  approvalThresholdCents: number;
  maxBatchesPerHour: number;
  killSwitch: boolean;
  trigger: {
    minMagnitude: number;
    minPagerAlert: PagerAlert;
    maxMagDelta: number;
    maxEpicentreDistanceKm: number;
    /** Max time difference between primary and corroborating origin times. */
    maxOriginTimeDeltaSec: number;
    /** Sources that must agree, counting the primary event itself. */
    minAgreeingSources: number;
  };
  /** Two events this close in space and time are treated as one disaster (R6). */
  sameDisaster: { radiusKm: number; windowHours: number };
  maxNoteChars: number;
  /** Used in place of an agent note that fails hygiene checks. */
  fallbackNote: string;
  /**
   * The message PayPal delivers with each payout, by locale ({amount} is filled in).
   * Fixed text a human signed off on: agent-written text never reaches a recipient.
   */
  payoutNotes: Record<string, string>;
  /** Who enrolled the households and how to reach them; filled into every payout note. */
  fieldPartner: { name: string; helpLine: string };
};

export type FirewallContext = {
  event: FirewallEvent;
  corroboration: CorroborationObservation[];
  registry: RegistryRecipient[];
  ledger: LedgerSnapshot;
  /** Advisory sentinel output (M2). true forces human approval. */
  sentinel: { injectionSuspected: boolean; findings: string[] };
  now: number;
  config: FirewallConfig;
};

export type ItemVerdict = {
  /** Index of the item in the submitted plan. */
  index: number;
  recipientId: string;
  requestedTier: Tier;
  allowedTier: Tier | null;
  distanceKm: number | null;
  amountCents: number;
  /** The message PayPal will deliver: the fixed template for the recipient's locale. */
  note: string;
  /** What the agent drafted (after hygiene checks). Shown to the reviewer only; never sent. */
  agentNote: string;
  verdict: VerdictKind;
  ruleTrace: RuleResult[];
};

export type Verdict = {
  overall: VerdictKind;
  eventId: string;
  decision: 'trigger' | 'hold' | 'escalate' | null;
  /** Sum of amounts of items that are not BLOCK. Zero when overall is BLOCK. */
  totalCents: number;
  planRules: RuleResult[];
  items: ItemVerdict[];
  /** Deterministic idempotency key for the payout batch built from payable items. */
  paypalRequestId: string | null;
  /** sha256 of the canonical verdict body; the audit entry references it (R11). */
  digest: string;
};
