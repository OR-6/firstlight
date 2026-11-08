'use client';

import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  ModuleRegistry,
  PinnedRowModule,
  RowAutoHeightModule,
  RowStyleModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ItemVerdict } from '@/firewall/types';
import type { PlanView } from '@/server/views';
import { StatusChip, itemStatus, usd } from './format';
import { flagText, noteChip } from './plain';

/**
 * Only the AG Grid features the plan and payouts grids use: client-side rows,
 * wrapped auto-height cells, cell and row styles, the pinned total row,
 * tooltips, and CSV export (Payouts). ValidationModule names a missing module in
 * development and is left out of production builds.
 */
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  RowAutoHeightModule,
  CellStyleModule,
  RowStyleModule,
  PinnedRowModule,
  ColumnAutoSizeModule,
  TooltipModule,
  CsvExportModule,
  ...(process.env.NODE_ENV === 'production' ? [] : [ValidationModule]),
]);

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

/** The pinned total row: payable households and what the firewall allowed in total. */
function totalRow(rows: PlanRow[]): PlanRow {
  const payable = rows.filter((r) => r.verdict !== 'BLOCK');
  return {
    index: -1,
    recipientId: 'Total',
    town: `${payable.length} ${payable.length === 1 ? 'household' : 'households'}`,
    locale: '',
    flags: [],
    amountCents: payable.reduce((t, r) => t + r.amountCents, 0),
    distanceKm: null,
  } as unknown as PlanRow;
}

const isTotal = (p: { node?: { rowPinned?: string | null } | null }) => Boolean(p.node?.rowPinned);

/** The language of the note PayPal sends, as a small chip; the full text is in the rule drawer. */
function NoteChip({ row }: { row: PlanRow }) {
  return (
    <span className="inline-flex items-center rounded-[var(--radius-chip)] border border-line-soft px-1.5 text-[0.8rem] leading-[1.5] text-ink-muted">
      {noteChip(row, row.locale)}
    </span>
  );
}

export function PlanGrid({ plan, onOpen }: { plan: PlanView; onOpen: (row: PlanRow) => void }) {
  const rows = useMemo(() => planRows(plan), [plan]);
  const pinned = useMemo(() => (rows.length ? [totalRow(rows)] : []), [rows]);
  const cols = useMemo<ColDef<PlanRow>[]>(
    () => [
      {
        field: 'recipientId',
        headerName: 'Recipient',
        flex: 1.2,
        minWidth: 190,
        cellRenderer: (p: ICellRendererParams<PlanRow>) =>
          p.data ? (
            <span>
              <span className={isTotal(p) ? 'font-[800]' : 'font-semibold'}>{p.data.recipientId}</span> <span className="text-ink-muted">{p.data.town}</span>
            </span>
          ) : null,
      },
      {
        field: 'distanceKm',
        headerName: 'Distance',
        width: 120,
        sortable: true,
        type: 'rightAligned',
        cellClass: 'num',
        valueFormatter: (p) => (p.value == null ? '' : `${Math.round(p.value)} km`),
      },
      {
        headerName: 'Tier',
        flex: 1,
        minWidth: 200,
        wrapText: true,
        autoHeight: true,
        cellClass: 'fl-wrap',
        valueGetter: (p) => p.data?.allowedTier ?? 'none',
        cellRenderer: (p: ICellRendererParams<PlanRow>) => {
          if (!p.data || isTotal(p)) return null;
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
        width: 130,
        sortable: true,
        type: 'rightAligned',
        cellClass: (p) => (isTotal(p) ? 'num font-[800]' : 'num font-semibold'),
        valueFormatter: (p) => (p.value ? usd(p.value) : '$0.00'),
      },
      {
        field: 'verdict',
        headerName: 'Status',
        width: 160,
        cellRenderer: (p: ICellRendererParams<PlanRow>) => {
          if (!p.data || isTotal(p)) return null;
          const st = itemStatus(plan, p.data.recipientId, p.data.verdict);
          return <StatusChip label={st.label} tone={st.tone} />;
        },
      },
      {
        field: 'note',
        headerName: 'Note',
        width: 150,
        tooltip: (p) => (p.data && !isTotal(p) ? p.data.note : undefined),
        cellRenderer: (p: ICellRendererParams<PlanRow>) => (p.data && !isTotal(p) ? <NoteChip row={p.data} /> : null),
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
          pinnedBottomRowData={pinned}
          columnDefs={cols}
          defaultColDef={{ sortable: false }}
          getRowId={(p) => `${p.data.index}`}
          onRowClicked={(e: RowClickedEvent<PlanRow>) => e.data && !e.node.rowPinned && onOpen(e.data)}
          getRowStyle={(p) => (p.node.rowPinned ? { cursor: 'default' } : { cursor: 'pointer' })}
          suppressCellFocus={false}
          onCellKeyDown={(e) => {
            const ev = e.event as KeyboardEvent | undefined;
            if (ev?.key === 'Enter' && e.data && !e.node.rowPinned) onOpen(e.data);
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
                {r.note ? <NoteChip row={r} /> : null}
              </span>
              {r.flags.length ? <span className="mt-1 block text-[0.85rem] text-ink-muted">{sentenceCase(flagText(r.flags))}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
