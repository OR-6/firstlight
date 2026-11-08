'use client';

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type RowClickedEvent } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ItemVerdict } from '@/firewall/types';
import type { PlanView } from '@/server/views';
import { StatusChip, itemStatus, usd } from './format';

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid themed to the console tokens. */
export const gridTheme = themeQuartz.withParams({
  browserColorScheme: 'dark',
  backgroundColor: '#1c2b37',
  foregroundColor: '#e4ecf1',
  chromeBackgroundColor: '#1c2b37',
  headerTextColor: '#93a7b6',
  headerFontWeight: 600,
  borderColor: '#263a4a',
  oddRowBackgroundColor: '#1c2b37',
  rowHoverColor: '#243644',
  selectedRowBackgroundColor: '#243644',
  accentColor: '#2eb5a4',
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
        headerName: 'Tier asked → allowed',
        width: 175,
        valueGetter: (p) => `${p.data?.requestedTier} → ${p.data?.allowedTier ?? 'none'}`,
        cellRenderer: (p: { data: PlanRow }) => {
          const changed = p.data.allowedTier !== p.data.requestedTier;
          return (
            <span>
              {p.data.requestedTier} <span className="text-ink-dim">→</span>{' '}
              <span className={changed ? 'font-bold text-hold' : 'font-semibold'}>{p.data.allowedTier ?? 'none'}</span>
              {p.data.flags.length ? <span className="ml-2 text-[0.8rem] text-ink-dim">{p.data.flags.join(', ').replaceAll('_', ' ')}</span> : null}
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
        minWidth: 240,
        tooltipField: 'note',
        cellRenderer: (p: { data: PlanRow }) => (
          <span>
            <span className="mr-2 rounded-[var(--radius-chip)] bg-raised px-1 text-[0.75rem] text-ink-muted">{p.data.locale}</span>
            {p.data.note}
          </span>
        ),
      },
    ],
    [plan],
  );

  return (
    <div>
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
  );
}
