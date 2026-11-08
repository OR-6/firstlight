'use client';

import L from 'leaflet';
import { useEffect, useRef } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { TONE_HEX, itemStatus, usd } from './format';

/**
 * Epicentre, the firewall's payout bands (rings), and every registered
 * recipient coloured by where their payment stands. The rings are the
 * distance bands the firewall enforces, not measured shaking intensity.
 *
 * Plain Leaflet driven by two effects (create/destroy, then redraw layers):
 * safe under React's double-invoked and re-attached effects.
 */
const BANDS = [
  { km: 300, tier: 'C', color: '#7fc4d8' },
  { km: 150, tier: 'B', color: '#e8c547' },
  { km: 50, tier: 'A', color: '#f08a4b' },
];

type Recipient = { recipientId: string; town: string; locale: string; flags: string[]; home: { lat: number; lon: number } };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export default function QuakeMap({
  event,
  plan,
  recipients,
  onSelect,
}: {
  event: EventView;
  plan: PlanView | null;
  recipients: Recipient[];
  onSelect?: (recipientId: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  // Create once per mount; destroy completely on cleanup.
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { center: [event.epicentre.lat + 0.35, event.epicentre.lon + 0.6], zoom: 7, scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
    };
    // The view is set once; data changes only redraw layers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    const centre: L.LatLngTuple = [event.epicentre.lat, event.epicentre.lon];
    for (const b of BANDS) {
      L.circle(centre, { radius: b.km * 1000, color: b.color, weight: 1.5, opacity: 0.9, fillColor: b.color, fillOpacity: 0.05, dashArray: b.tier === 'C' ? '6 6' : undefined })
        .bindTooltip(`Tier ${b.tier} band: up to ${b.km} km`, { className: 'fl-tip', sticky: true })
        .addTo(g);
    }
    L.circleMarker(centre, { radius: 7, color: '#fff', weight: 2, fillColor: '#e5534b', fillOpacity: 1 })
      .bindTooltip(`Epicentre: M${event.mag} ${esc(event.place ?? '')}`, { className: 'fl-tip', direction: 'top', offset: [0, -8] })
      .addTo(g);
    const items = new Map(plan?.verdict?.items.map((i) => [i.recipientId, i]) ?? []);
    for (const r of recipients) {
      const item = items.get(r.recipientId);
      const st = item && plan ? itemStatus(plan, r.recipientId, item.verdict) : null;
      const label = item && st ? `${st.label}${item.amountCents ? `: ${usd(item.amountCents)}, tier ${item.allowedTier}` : ''}` : plan ? 'Not in the plan' : 'Registered';
      L.circleMarker([r.home.lat, r.home.lon], { radius: 6, color: '#16222c', weight: 2, fillColor: st ? TONE_HEX[st.tone] : TONE_HEX.muted, fillOpacity: 1 })
        .bindTooltip(`<strong>${esc(r.recipientId)}</strong> ${esc(r.town)}<br>${esc(label)}`, { className: 'fl-tip', direction: 'right', offset: [8, 0] })
        .on('click', () => select.current?.(r.recipientId))
        .addTo(g);
    }
  }, [event, plan, recipients]);

  return <div ref={el} className="h-full min-h-[360px] w-full" role="img" aria-label={`Map of the epicentre near ${event.place ?? ''}, payout bands and recipients`} />;
}
