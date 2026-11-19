import { CategoryChip, FlagPill, StatusBadge, ToneSwatch } from '../components/Badges';
import { CATEGORY_DOMAINS, CategoryDomainKey, contrast, DWELL_RAMP, FLAGS, FlagKey, LINE_PALETTE, STATUS_DOMAINS, StatusDomainKey, TONES, ToneKey } from '../theme/colors';

/** The colour guide, rendered from the same source the screens use. */
export function ColorGuide() {
  return (
    <>
      <h1>Colour guide</h1>
      <p className="lead">The same value has the same colour on every screen. Shape tells you what kind of value it is:
        a <strong>filled badge with an icon</strong> is a status, an <strong>outlined chip with a colour bar</strong> is a category,
        and a <strong>pill with a symbol</strong> is a special-handling flag. Colour is never the only signal.</p>

      <section className="card">
        <h3>Status tones</h3>
        <table className="grid small">
          <thead><tr><th>Tone</th><th>Meaning</th><th>Text contrast</th></tr></thead>
          <tbody>
            {Object.values(TONES).map((t) => (
              <tr key={t.key}><td><ToneSwatch tone={t.key as ToneKey} /></td><td>{t.meaning}</td><td>{contrast(t.fg, t.bg).toFixed(1)}:1</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {(Object.keys(STATUS_DOMAINS) as StatusDomainKey[]).map((k) => {
        const d = STATUS_DOMAINS[k];
        return (
          <section className="card" key={k}>
            <h3>{d.label} <span className="muted small">· {d.where}</span></h3>
            <table className="grid small">
              <tbody>
                {Object.entries(d.values).map(([v, sv]) => (
                  <tr key={v}><td style={{ width: 180 }}><StatusBadge domain={k} value={v} /></td><td className="mono small">{v}</td><td>{sv.meaning}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {(Object.keys(CATEGORY_DOMAINS) as CategoryDomainKey[]).map((k) => {
        const d = CATEGORY_DOMAINS[k];
        return (
          <section className="card" key={k}>
            <h3>{d.label} <span className="muted small">· {d.where}</span></h3>
            <table className="grid small">
              <tbody>
                {Object.entries(d.values).map(([v, cv]) => (
                  <tr key={v}><td style={{ width: 180 }}><CategoryChip domain={k} value={v} /></td><td className="mono small">{cv.color}</td><td>{cv.meaning}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      <section className="card">
        <h3>Special-handling flags</h3>
        <table className="grid small">
          <tbody>
            {(Object.keys(FLAGS) as FlagKey[]).map((k) => <tr key={k}><td style={{ width: 180 }}><FlagPill flag={k} /></td><td>{FLAGS[k].meaning}</td></tr>)}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Yard colouring</h3>
        <p>The yard can be coloured by category (default), line, dwell time, or holds and special cargo. Dwell time uses one purple ramp so it never reads as a status:</p>
        <div className="legend">{DWELL_RAMP.map((b) => <span key={b.label} className="legend-swatch"><i style={{ background: b.color }} />{b.label}</span>)}</div>
        <p>Lines get colours from this colour-blind-safe list, assigned alphabetically by line code:</p>
        <div className="legend">{LINE_PALETTE.map((c) => <span key={c} className="legend-swatch"><i style={{ background: c }} />{c}</span>)}</div>
      </section>
    </>
  );
}
