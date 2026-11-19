import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { CategoryChip, CategoryLegend } from '../components/Badges';
import { DataGrid, GridColumn } from '../grid/DataGrid';
import { bool, category, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { categoryOf, textOn } from '../theme/colors';
import { TerminalMap } from '../types';

type Block = TerminalMap['blocks'][number];
type Berth = TerminalMap['berths'][number];

const capacityOf = (b: Block) => (b.blockType === 'CONTAINER_STACK' ? b.bays * b.rows * b.tiers : (b.capacity ?? 0));

const blockColumns: GridColumn<Block>[] = [
  text('code', 'Block', (r) => r.code, { render: (r) => <span className="mono">{r.code}</span> }),
  text('yard', 'Yard', (r) => r.yard),
  category('type', 'Type', 'blockType', (r) => r.blockType),
  text('size', 'Layout', (r) => (r.blockType === 'CONTAINER_STACK' ? `${r.bays} bays × ${r.rows} rows × ${r.tiers} tiers` : null)),
  num('capacity', 'Capacity', (r) => capacityOf(r)),
  text('unit', 'Unit', (r) => r.capacityUnit),
  num('occupied', 'Occupied', (r) => r.occupied),
  num('fill', 'Fill %', (r) => (capacityOf(r) ? Math.round((100 * r.occupied) / capacityOf(r)) : null)),
  text('eq', 'Machines', (r) => r.equipmentKind),
  text('sizes', 'Sizes', (r) => (r.blockType === 'CONTAINER_STACK' ? r.allowedSizes.join('/') : null)),
  num('plugs', 'Reefer plugs', (r) => r.reeferPlugs),
  text('dg', 'DG classes', (r) => r.dgClasses.join(', ')),
  num('maxStack', 'Max stack kg', (r) => r.maxStackKg, { hiddenByDefault: true }),
];

const berthColumns: GridColumn<Berth>[] = [
  text('code', 'Berth', (r) => r.code),
  text('name', 'Name', (r) => r.name),
  enumCol('kind', 'Kind', (r) => r.berthKind, ['QUAY', 'RORO_RAMP', 'LIQUID_JETTY', 'BARGE']),
  num('start', 'From m', (r) => r.startMarkM),
  num('length', 'Length m', (r) => r.lengthM),
  num('depth', 'Depth m', (r) => r.depthM),
  text('bollards', 'Bollards', (r) => (r.bollardFrom ? `${r.bollardFrom}–${r.bollardTo ?? ''}` : null)),
];

type Track = TerminalMap['railTracks'][number];
type Lane = TerminalMap['gateLanes'][number];
type CorridorLink = TerminalMap['links'][number];

const railColumns: GridColumn<Track>[] = [
  text('code', 'Track', (r) => r.code), num('length', 'Length m', (r) => r.lengthM), num('wagons', 'Max wagons', (r) => r.maxWagons),
];

const laneColumns: GridColumn<Lane>[] = [
            text('code', 'Lane', (r) => r.code),
            enumCol('direction', 'Direction', (r) => r.direction, ['IN', 'OUT', 'BOTH']),
            enumCol('kind', 'Kind', (r) => r.laneKind, ['STANDARD', 'TROUBLE', 'OOG']),
            bool('ocr', 'OCR', (r) => r.hasOcr),
            status('status', 'Status', 'laneStatus', (r) => r.status),
          ];

const linkColumns: GridColumn<CorridorLink>[] = [
            text('from', 'From', (r) => r.fromFacility),
            text('to', 'To', (r) => r.toFacility),
            text('kinds', 'Destination kind', (r) => r.toKinds.join(', '), {
              render: (r) => <span className="flags">{r.toKinds.map((k: string) => <CategoryChip key={k} domain="facilityKind" value={k} />)}</span>,
            }),
            enumCol('mode', 'Mode', (r) => r.mode, ['RAIL', 'TRUCK', 'BARGE']),
            num('hours', 'Transit h', (r) => r.transitHours),
            bool('bonded', 'Bonded', (r) => r.bonded),
          ];

export function Terminal() {
  const t = useApi<TerminalMap>('/v1/terminal');
  const { roles } = useSession();
  const [tab, setTab] = useState<'blocks' | 'berths' | 'rail' | 'lanes' | 'links'>('blocks');
  useLive(['unit.'], t.reload, 1000);
  const d = t.data;
  const admin = can(roles, 'tos:admin');
  return (
    <>
      <h1>Terminal</h1>
      {d && (
        <div className="kv card">
          <span><b>{d.facility}</b></span>
          {d.kinds.map((k) => <CategoryChip key={k} domain="facilityKind" value={k} />)}
          <span>{d.berths.length} berths · {d.blocks.length} yard areas · {d.railTracks.length} rail tracks · {d.gateLanes.length} gate lanes</span>
        </div>
      )}
      {t.error && <p className="error">{t.error}</p>}
      {d && <TerminalSketch map={d} />}
      <div className="tabs" role="tablist">
        {(['blocks', 'berths', 'rail', 'lanes', 'links'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {{ blocks: 'Yard areas', berths: 'Berths', rail: 'Rail tracks', lanes: 'Gate lanes', links: 'Corridors' }[k]}
          </button>
        ))}
      </div>
      {tab === 'blocks' && (
        <DataGrid id="terminal-blocks" rows={d?.blocks} loading={t.loading} columns={blockColumns} rowKey={(r) => r.id}
          quickFilters={['type']} legend={<CategoryLegend domain="blockType" />} />
      )}
      {tab === 'berths' && (
        <DataGrid id="terminal-berths" rows={d?.berths} loading={t.loading} columns={berthColumns} rowKey={(r) => r.id}
          defaultSort={[{ columnId: 'start', dir: 'asc' }]}
          actions={admin && <NewBerth onDone={t.reload} />} />
      )}
      {tab === 'rail' && (
        <DataGrid id="terminal-rail" rows={d?.railTracks} loading={t.loading} rowKey={(r) => r.id}
          columns={railColumns} />
      )}
      {tab === 'lanes' && (
        <DataGrid id="terminal-lanes" rows={d?.gateLanes} loading={t.loading} rowKey={(r) => r.id}
          columns={laneColumns} />
      )}
      {tab === 'links' && (
        <DataGrid id="terminal-links" rows={d?.links} loading={t.loading} rowKey={(r) => r.id}
          columns={linkColumns} />
      )}
    </>
  );
}

/**
 * Schematic of the facility: quay along the top (berths to scale by quay metres), yard areas below coloured by
 * type with a fill bar, rail tracks and gate lanes at the bottom. Uses drawn coordinates when every element has them.
 */
function TerminalSketch({ map }: { map: TerminalMap }) {
  const W = 960;
  const pad = 16;
  const quayLen = Math.max(1, ...map.berths.map((b) => b.startMarkM + b.lengthM));
  const scale = (W - 2 * pad) / quayLen;
  const cols = Math.max(1, Math.min(6, map.blocks.length));
  const tileW = (W - 2 * pad - (cols - 1) * 12) / cols;
  const tileH = 64;
  const yardTop = map.berths.length ? 70 : 16;
  const rowsN = Math.ceil(map.blocks.length / cols);
  const railTop = yardTop + rowsN * (tileH + 12) + 8;
  const laneTop = railTop + map.railTracks.length * 18 + (map.railTracks.length ? 12 : 0);
  const H = laneTop + (map.gateLanes.length ? 40 : 0) + pad;
  if (!map.berths.length && !map.blocks.length) return <p className="muted">No layout recorded for this facility yet.</p>;
  return (
    <figure className="card sketch">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Layout of ${map.facility}`}>
        {map.berths.length > 0 && (
          <g>
            <rect x={pad} y={8} width={W - 2 * pad} height={8} fill="#B9C6D6" />
            <text x={W - pad} y={58} textAnchor="end" className="sk-label">quay metres</text>
            {map.berths.map((b) => (
              <g key={b.id}>
                <title>{`${b.code} ${b.name}: ${b.startMarkM}–${b.startMarkM + b.lengthM} m${b.depthM ? `, ${b.depthM} m deep` : ''}`}</title>
                <rect x={pad + b.startMarkM * scale} y={18} width={Math.max(2, b.lengthM * scale - 2)} height={14} rx={3}
                  fill={b.berthKind === 'QUAY' ? '#2F7BD6' : b.berthKind === 'RORO_RAMP' ? '#7B4FA0' : b.berthKind === 'LIQUID_JETTY' ? '#1C7F80' : '#5E5E5E'} />
                <text x={pad + b.startMarkM * scale + 4} y={29} fill="#fff" className="sk-small">{b.code}</text>
                <text x={pad + b.startMarkM * scale + 4} y={58} className="sk-small muted-fill">{b.startMarkM}</text>
              </g>
            ))}
          </g>
        )}
        {map.blocks.map((b, i) => {
          const x = pad + (i % cols) * (tileW + 12);
          const y = yardTop + Math.floor(i / cols) * (tileH + 12);
          const c = categoryOf('blockType', b.blockType)!;
          const cap = capacityOf(b);
          const fill = cap ? Math.min(1, b.occupied / cap) : 0;
          return (
            <g key={b.id}>
              <title>{`${b.code} · ${c.label} · ${b.occupied}/${cap} ${b.capacityUnit ?? ''}${b.reeferPlugs ? ` · ${b.reeferPlugs} reefer plugs` : ''}${b.dgClasses.length ? ` · DG classes ${b.dgClasses.join(', ')}` : ''}`}</title>
              <rect x={x} y={y} width={tileW} height={tileH} rx={6} fill={c.color} />
              <text x={x + 10} y={y + 22} fill={textOn(c.color)} className="sk-name">{c.icon} {b.code}</text>
              <text x={x + 10} y={y + 40} fill={textOn(c.color)} className="sk-small">{b.occupied}/{cap} {b.capacityUnit?.toLowerCase()}</text>
              {(b.reeferPlugs > 0 || b.dgClasses.length > 0) && (
                <text x={x + tileW - 10} y={y + 22} fill={textOn(c.color)} textAnchor="end" className="sk-small">
                  {b.reeferPlugs > 0 ? `❄ ${b.reeferPlugs}` : ''}{b.reeferPlugs > 0 && b.dgClasses.length ? '  ' : ''}{b.dgClasses.length ? '◆ DG' : ''}
                </text>
              )}
              <rect x={x + 10} y={y + tileH - 14} width={tileW - 20} height={6} rx={3} fill="rgba(255,255,255,0.35)" />
              <rect x={x + 10} y={y + tileH - 14} width={(tileW - 20) * fill} height={6} rx={3} fill="#FFFFFF" />
            </g>
          );
        })}
        {map.railTracks.map((t, i) => (
          <g key={t.id}>
            <title>{`Rail track ${t.code}: ${t.lengthM} m${t.maxWagons ? `, ${t.maxWagons} wagons` : ''}`}</title>
            <line x1={pad + 70} x2={W - pad} y1={railTop + i * 18 + 6} y2={railTop + i * 18 + 6} stroke="#5E5E5E" strokeWidth={3} strokeDasharray="10 3" />
            <text x={pad} y={railTop + i * 18 + 10} className="sk-small">Rail {t.code}</text>
          </g>
        ))}
        {map.gateLanes.map((l, i) => (
          <g key={l.id}>
            <title>{`Gate lane ${l.code}: ${l.direction}${l.hasOcr ? ', OCR' : ''}${l.laneKind !== 'STANDARD' ? `, ${l.laneKind.toLowerCase()}` : ''}`}</title>
            <rect x={pad + i * 74} y={laneTop} width={66} height={26} rx={4} fill="none" stroke={l.laneKind === 'TROUBLE' ? '#D23A2F' : '#4A5568'} strokeDasharray={l.status === 'CLOSED' ? '4 3' : undefined} />
            <text x={pad + i * 74 + 33} y={laneTop + 17} textAnchor="middle" className="sk-small">{l.direction === 'IN' ? '→' : l.direction === 'OUT' ? '←' : '⇄'} {l.code}</text>
          </g>
        ))}
      </svg>
      <figcaption><CategoryLegend domain="blockType" /></figcaption>
    </figure>
  );
}

function NewBerth({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', berthKind: 'QUAY', startMarkM: '0', lengthM: '', depthM: '' });
  const { busy, error, run } = useAction();
  if (!open) return <button onClick={() => setOpen(true)}>Add berth</button>;
  return (
    <form className="form-row inline" onSubmit={(e) => { e.preventDefault(); run(async () => {
      await api.post('/v1/terminal/berths', {
        code: f.code.trim(), name: f.name.trim() || f.code.trim(), berthKind: f.berthKind,
        startMarkM: Number(f.startMarkM), lengthM: Number(f.lengthM), depthM: f.depthM ? Number(f.depthM) : undefined,
      });
      setOpen(false); onDone();
    }); }}>
      <input required placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={{ width: 80 }} />
      <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.berthKind} onChange={(e) => setF({ ...f, berthKind: e.target.value })} aria-label="Kind">
        {['QUAY', 'RORO_RAMP', 'LIQUID_JETTY', 'BARGE'].map((k) => <option key={k}>{k}</option>)}
      </select>
      <input required type="number" min={0} placeholder="From m" value={f.startMarkM} onChange={(e) => setF({ ...f, startMarkM: e.target.value })} style={{ width: 90 }} />
      <input required type="number" min={1} placeholder="Length m" value={f.lengthM} onChange={(e) => setF({ ...f, lengthM: e.target.value })} style={{ width: 90 }} />
      <input type="number" min={1} step="0.1" placeholder="Depth m" value={f.depthM} onChange={(e) => setF({ ...f, depthM: e.target.value })} style={{ width: 90 }} />
      <button className="primary" disabled={busy}>Save</button>
      <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
