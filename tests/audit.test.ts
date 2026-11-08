import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/lib/canonical';
import { AuditLog, GENESIS_HASH, entryHash, redactSecrets, verifyEntries } from '../src/ledger/audit';
import { openDb } from '../src/ledger/db';

function seeded() {
  let t = 1_000;
  const db = openDb();
  const log = new AuditLog(db, () => t++);
  log.append('signal.received', { eventId: 'us6000u18k', mag: 7.7 });
  log.append('agent.plan', { decision: 'trigger', items: 2 });
  log.append('firewall.verdict', { digest: 'd'.repeat(64), overall: 'ALLOW' });
  log.append('paypal.request', { headers: { Authorization: 'Bearer abc123' }, client_secret: 's3cr3t', body: { items: 2 } });
  return { db, log };
}

describe('canonicalJson', () => {
  it.each([
    ['sorts keys recursively', { b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }, '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}'],
    ['drops undefined object values', { a: 1, b: undefined }, '{"a":1}'],
    ['keeps unicode as-is', { n: 'आपतकालीन' }, '{"n":"आपतकालीन"}'],
  ])('%s', (_name, input, expected) => {
    expect(canonicalJson(input)).toBe(expected);
  });

  it.each([
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['Date objects', { a: new Date(0) }],
    ['bigint', { a: 1n }],
  ])('rejects %s', (_name, input) => {
    expect(() => canonicalJson(input)).toThrow(TypeError);
  });
});

describe('audit hash chain', () => {
  it('builds a valid chain from genesis', () => {
    const { log } = seeded();
    const entries = log.entries();
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    for (let i = 1; i < entries.length; i++) expect(entries[i]?.prevHash).toBe(entries[i - 1]?.hash);
    expect(log.verify()).toEqual({ ok: true, count: 4, headHash: log.head() });
  });

  it('redacts secrets before hashing and storing', () => {
    const { log } = seeded();
    const stored = JSON.stringify(log.entries()[3]?.payload);
    expect(stored).not.toContain('abc123');
    expect(stored).not.toContain('s3cr3t');
    expect(stored).toContain('[REDACTED]');
    expect(redactSecrets({ nested: [{ api_key: 'k', ok: 1 }] })).toEqual({ nested: [{ api_key: '[REDACTED]', ok: 1 }] });
  });

  it('the database refuses UPDATE and DELETE', () => {
    const { db } = seeded();
    expect(() => db.prepare("UPDATE audit_log SET payload = '{}' WHERE seq = 2").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log WHERE seq = 4').run()).toThrow(/append-only/);
  });

  // An attacker with raw DB access can drop the triggers; the chain must still expose tampering.
  type Tamper = { name: string; sql: string[]; brokenAt: number };
  const tampers: Tamper[] = [
    { name: 'edited payload', sql: [`UPDATE audit_log SET payload = '{"decision":"trigger","items":20}' WHERE seq = 2`], brokenAt: 2 },
    { name: 'edited timestamp', sql: ['UPDATE audit_log SET ts_ms = ts_ms + 1 WHERE seq = 3'], brokenAt: 3 },
    { name: 'deleted middle row', sql: ['DELETE FROM audit_log WHERE seq = 2'], brokenAt: 3 },
    { name: 'deleted head row then re-appended forged row', sql: ['DELETE FROM audit_log WHERE seq = 4', `INSERT INTO audit_log VALUES (4, 9, 'paypal.request', '{}', 'x', 'y')`], brokenAt: 4 },
    {
      name: 'rewrote a row with a self-consistent hash (but not the next prevHash)',
      sql: [], // filled in below
      brokenAt: 3,
    },
  ];

  it.each(tampers)('detects tampering: $name', ({ name, sql, brokenAt }) => {
    const { db, log } = seeded();
    db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    if (name.startsWith('rewrote')) {
      const e = log.entries()[1]!;
      const payload = { decision: 'trigger', items: 99 };
      const hash = entryHash(e.prevHash, { ...e, payload });
      db.prepare('UPDATE audit_log SET payload = ?, hash = ? WHERE seq = 2').run(canonicalJson(payload), hash);
    }
    for (const s of sql) db.exec(s);
    const check = log.verify();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.brokenAtSeq).toBe(brokenAt);
  });

  it('verifies a prefix up to a given hash (donor receipt check)', () => {
    const { log } = seeded();
    const second = log.entries()[1]!.hash;
    expect(log.verify(second)).toEqual({ ok: true, count: 2, headHash: second });
    expect(log.verify('f'.repeat(64)).ok).toBe(false);
  });

  it('R11 support: finds logged verdicts by digest', () => {
    const { log } = seeded();
    expect(log.hasVerdict('d'.repeat(64))).toBe(true);
    expect(log.hasVerdict('e'.repeat(64))).toBe(false);
  });

  it('pure verifier rejects out-of-order entries', () => {
    const { log } = seeded();
    const [a, b, ...rest] = log.entries();
    expect(verifyEntries([b!, a!, ...rest]).ok).toBe(false);
  });
});
