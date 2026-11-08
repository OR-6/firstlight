/**
 * Fetch a live USGS summary feed and list events that would meet the default
 * trigger threshold. Read-only; no credentials needed.
 *
 *   npm run fetch:usgs                 # significant_month
 *   npm run fetch:usgs -- 4.5 week
 */
import { defaultFirewallConfig } from '../src/firewall/config';
import { pagerAtLeast } from '../src/firewall/tiers';
import { fetchUsgsFeed, type UsgsFeedLevel, type UsgsFeedWindow } from '../src/signals/usgs';

const [level = 'significant', window = 'month'] = process.argv.slice(2) as [UsgsFeedLevel?, UsgsFeedWindow?];
const { trigger } = defaultFirewallConfig();

const { generatedAt, events, rejected } = await fetchUsgsFeed({ level, window });
console.log(`USGS ${level}_${window} — generated ${new Date(generatedAt).toISOString()} — ${events.length} events, ${rejected.length} rejected\n`);
for (const e of events) {
  const meets = e.mag >= trigger.minMagnitude || pagerAtLeast(e.alert, trigger.minPagerAlert);
  console.log(
    [
      meets ? 'TRIGGER' : '       ',
      e.id.padEnd(14),
      `M${e.mag.toFixed(1)}`.padEnd(6),
      (e.alert ?? '-').padEnd(7),
      e.status.padEnd(9),
      new Date(e.time).toISOString().slice(0, 16),
      e.place ?? '',
    ].join('  '),
  );
}
for (const r of rejected) console.log(`rejected ${r.id ?? '?'}: ${r.error}`);
