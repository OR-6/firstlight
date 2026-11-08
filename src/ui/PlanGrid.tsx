'use client';

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type RowClickedEvent } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ItemVerdict } from '@/firewall/types';
import type { PlanView } from '@/server/views';
import { StatusChip, itemStatus, usd } from './format';
import { flagText, noteLang } from './plain';

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid themed to the console tokens. */
export const gridTheme = themeQuartz.withParams({
  browserColorScheme: 'light',
  backgroundColor: '#ffffff',
  foregroundColor: '#000000',
  chromeBackgroundColor: '#f1f4f2',
  headerTextColor: '#3f4744',
  headerFontWeight: 700,
  borderColor: '#d8dedb',
  oddRowBackgroundColor: '#ffffff',
  rowHoverColor: '#f1f4f2',
  selectedRowBackgroundColor: '#dcefe7',
  accentColor: '#0b4a8f',
  fontFamily: 'inherit',
  fontSize: 14,
  spacing: 7,
  cellHorizontalPadding: 14,
  wrapperBorderRadius: 0,
  headerColumnBorder: false,
});

export type PlanRow = ItemVerdict & { town: string; locale: string; flags: string[] };

export function planRows(plan: PlanView): PlanRow[] {
  const reg = new Map(plan.recipients.map((r) => [r.recipientId, r]));
  return (plan.verdict?.items ?? []).map((i) => {
    const r = reg.get(i.recipientId);
    return { ...i, town: r?.town ?? 'Not in registry', locale: r?.locale ?? '', flags: r?.flags ?? [] };
  });
}

export function PlanGrid({ plan, onOpen }: { plan: PlanView; onOpen: (row: PlanRow) => void }) {
  const rows = useMemo(() => planRows(plan), [plan]);
  const cols = useMemo<ColDef<PlanRow>[]>(
    () => [
      {
        field: 'recipientId',
        headerName: 'Recipient',
        minWidth: 150,
        cellRenderer: (p: { data: PlanRow }) => (
          <span>
            <span className="font-semibold">{p.data.recipientId}</span> <span className="text-ink-muted">{p.data.town}</span>
          </span>
        ),
      },
      {
        field: 'distanceKm',
        headerName: 'Distance',
        width: 110,
        type: 'rightAligned',
        cellClass: 'num',
        valueFormatter: (p) => (p.value == null ? '' : `${Math.round(p.value)} km`),
      },
      {
        headerName: 'Tier',
        width: 190,
        wrapText: true,
        autoHeight: true,
        cellClass: 'fl-wrap',
        valueGetter: (p) => p.data?.allowedTier ?? 'none',
        cellRenderer: (p: { data: PlanRow }) => {
          const changed = p.data.allowedTier !== p.data.requestedTier;
          return (
            <span>
              <span className={changed ? 'font-bold text-block' : 'font-semibold'}>{p.data.allowedTier ?? 'None'}</span>
              {changed ? <span className="text-block">, asked for {p.data.requestedTier}</span> : null}
              {p.data.flags.length ? <span className="ml-2 text-[0.8rem] text-ink-dim">{flagText(p.data.flags)}</span> : null}
            </span>
          );
        },
      },
      {
        field: 'amountCents',
        headerName: 'Amount',
        width: 115,
        type: 'rightAligned',
        cellClass: 'num font-semibold',
        valueFormatter: (p) => (p.value ? usd(p.value) : '$0.00'),
      },
      {
        field: 'verdict',
        headerName: 'Status',
        width: 150,
        cellRenderer: (p: { data: PlanRow }) => {
          const st = itemStatus(plan, p.data.recipientId, p.data.verdict);
          return <StatusChip label={st.label} tone={st.tone} />;
        },
      },
      {
        field: 'note',
        headerName: 'Note to recipient',
        flex: 1,
        minWidth: 260,
        // Wrap long notes onto more lines instead of running off the right edge.
        wrapText: true,
        autoHeight: true,
        cellClass: 'fl-wrap',
        cellRenderer: (p: { data: PlanRow }) => (
          <span>
            <span className="mr-2 rounded-[var(--radius-chip)] border border-line-soft px-1 text-[0.75rem] text-ink-muted">{p.data.locale}</span>
            <span lang={noteLang(p.data, p.data.locale)}>{p.data.note}</span>
          </span>
        ),
      },
    ],
    [plan],
  );

  return (
    <div>
      <RecipientCards plan={plan} rows={rows} onOpen={onOpen} />
      <div className="hidden md:block">
      <AgGridReact<PlanRow>
        theme={gridTheme}
        domLayout="autoHeight"
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => `${p.data.index}`}
        onRowClicked={(e: RowClickedEvent<PlanRow>) => e.data && onOpen(e.data)}
        rowStyle={{ cursor: 'pointer' }}
        suppressCellFocus={false}
        onCellKeyDown={(e) => {
          const ev = e.event as KeyboardEvent | undefined;
          if (ev?.key === 'Enter' && e.data) onOpen(e.data);
        }}
        overlayNoRowsTemplate="<span>No recipients in this plan.</span>"
      />
      </div>
    </div>
  );
}

/** Tier as a small sign plate. A lowered tier shows what the agent asked for. */
function TierPlate({ row }: { row: PlanRow }) {
  const changed = row.allowedTier !== row.requestedTier;
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.85rem]">
      <span
        className={`num inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-chip)] border-2 px-1 font-[800] leading-none ${
          row.allowedTier ? 'border-black bg-panel text-black' : 'border-line text-ink-dim'
        }`}
        aria-hidden
      >
        {row.allowedTier ?? 'none'}
      </span>
      <span className={changed ? 'font-semibold text-block' : 'text-ink-muted'}>
        {row.allowedTier ? `Tier ${row.allowedTier}` : 'No tier'}
        {changed ? `, asked for ${row.requestedTier}` : ''}
      </span>
    </span>
  );
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Below 768 px: one card per recipient instead of the grid. Tapping a card opens the same rule drawer. */
function RecipientCards({ plan, rows, onOpen }: { plan: PlanView; rows: PlanRow[]; onOpen: (row: PlanRow) => void }) {
  if (rows.length === 0) return <p className="p-5 text-ink-muted md:hidden">No recipients in this plan.</p>;
  return (
    <ul className="divide-y divide-line-soft md:hidden">
      {rows.map((r) => {
        const st = itemStatus(plan, r.recipientId, r.verdict);
        return (
          <li key={r.index}>
            <button
              type="button"
              onClick={() => onOpen(r)}
              className="block w-full px-4 py-3 text-left hover:bg-raised"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-semibold leading-snug">{r.town}</span>
                  <span className="num block text-[0.82rem] text-ink-dim">
                    {r.recipientId}
                    {r.distanceKm != null ? `, ${Math.round(r.distanceKm)} km away` : ''}
                  </span>
                </span>
                <span className="num shrink-0 text-[1.05rem] font-[800]">{usd(r.amountCents)}</span>
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <TierPlate row={r} />
                <StatusChip label={st.label} tone={st.tone} />
              </span>
              {r.flags.length ? <span className="mt-1 block text-[0.85rem] text-ink-muted">{sentenceCase(flagText(r.flags))}</span> : null}
              {r.note ? (
                <span className="mt-2 block text-[0.88rem] leading-snug text-ink-muted" lang={noteLang(r, r.locale)}>
                  {r.note}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
