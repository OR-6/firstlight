import { z } from 'zod';
import type { RegistryRecipient } from '../firewall/types';
import seed from './registry.seed.json' with { type: 'json' };

/**
 * Public registry profiles: what the agent and the firewall may know.
 * There is deliberately no email or account field here. Payee addresses are
 * in the payee map (payees.ts), which only the payout executor imports.
 */
const ProfileSchema = z.strictObject({
  recipientId: z.string().regex(/^rcp_[a-z0-9_]{1,40}$/),
  displayName: z.string().max(80),
  town: z.string().max(80),
  home: z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  flags: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(10),
  verified: z.boolean(),
  registeredAt: z.iso.datetime(),
});

export type RegistryProfile = z.infer<typeof ProfileSchema>;

export function parseRegistry(raw: unknown): RegistryProfile[] {
  const list = z.object({ recipients: z.array(ProfileSchema).max(10_000) }).parse(raw).recipients;
  const ids = new Set<string>();
  for (const r of list) {
    if (ids.has(r.recipientId)) throw new Error(`duplicate recipientId ${r.recipientId}`);
    ids.add(r.recipientId);
  }
  return list;
}

let cached: RegistryProfile[] | null = null;

/** The seeded demo registry (deterministic, loaded once). */
export function loadRegistry(): RegistryProfile[] {
  cached ??= parseRegistry(seed);
  return cached;
}

/** Shape the firewall evaluates against. */
export function toFirewallRegistry(profiles: readonly RegistryProfile[]): RegistryRecipient[] {
  return profiles.map((p) => ({
    recipientId: p.recipientId,
    verified: p.verified,
    registeredAt: Date.parse(p.registeredAt),
    home: p.home,
    locale: p.locale,
    flags: p.flags,
  }));
}
