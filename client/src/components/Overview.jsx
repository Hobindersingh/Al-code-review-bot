import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const SEV_COLOR = { critical: '#8f2a20', high: '#b3382c', medium: '#c98a2b', low: '#4f7fc4', info: '#8a93a6' };
const ORDER = ['critical', 'high', 'medium', 'low', 'info'];

const secs = (ms) => (ms ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : '–');
const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact' }).format(n ?? 0);

export default function Overview({ stats, days }) {
  const { totals, daily, severity, category, acceptanceRate, ratedFindings, repos } = stats;
  const sevCount = Object.fromEntries(severity.map((s) => [s.name, s.count]));
  const sevTotal = ORDER.reduce((n, k) => n + (sevCount[k] ?? 0), 0);
  const maxCat = Math.max(1, ...category.map((c) => c.count));
  const finished = totals.completed + totals.failed;

  if (!totals.reviews) {
    return <div className="notice"><h3>No reviews in the last {days} days</h3><p>Open or update a pull request in a repository connected to your webhook. Results appear here within a minute.</p></div>;
  }

  return (
    <>
      <dl className="ledger">
        <div><dt>Pull requests reviewed</dt><dd>{totals.completed}<small> of {totals.reviews}</small></dd></div>
        <div><dt>Findings raised</dt><dd>{totals.findings}</dd></div>
        <div><dt>Marked helpful</dt><dd>{acceptanceRate == null ? '–' : `${Math.round(acceptanceRate * 100)}%`}<small> {ratedFindings ? `of ${ratedFindings} rated` : 'none rated yet'}</small></dd></div>
        <div><dt>Average run time</dt><dd>{secs(totals.avgDurationMs)}</dd></div>
        <div><dt>Tokens used</dt><dd>{compact(totals.tokens)}</dd></div>
        <div><dt>Failure rate</dt><dd>{finished ? `${Math.round((totals.failed / finished) * 100)}%` : '–'}</dd></div>
      </dl>

      <section className="panel">
        <h3>Reviews and findings per day</h3>
        <div style={{ height: 230 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={daily} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#8a93a655" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} tick={{ fontSize: 12, fill: '#8a93a6' }} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#8a93a6' }} />
              <Tooltip />
              <Area type="monotone" dataKey="findings" name="Findings" stroke="#b3382c" fill="#b3382c" fillOpacity={0.14} />
              <Area type="monotone" dataKey="reviews" name="Reviews" stroke="#2f7a5a" fill="#2f7a5a" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="two">
        <section className="panel">
          <h3>Findings by severity</h3>
          {sevTotal ? (
            <>
              <div className="sevbar" role="img" aria-label="Severity distribution">
                {ORDER.filter((k) => sevCount[k]).map((k) => <span key={k} style={{ width: `${(sevCount[k] / sevTotal) * 100}%`, background: SEV_COLOR[k] }} />)}
              </div>
              <ul className="legend">
                {ORDER.map((k) => <li key={k}><span><i className="dot" style={{ background: SEV_COLOR[k] }} />{k}</span><span className="num">{sevCount[k] ?? 0}</span></li>)}
              </ul>
            </>
          ) : <p className="empty">No findings yet.</p>}
        </section>
        <section className="panel">
          <h3>Findings by category</h3>
          {category.length ? category.map((c) => (
            <div className="catrow" key={c.name}><span>{c.name}</span><div className="catbar"><span style={{ width: `${(c.count / maxCat) * 100}%` }} /></div><span className="num">{c.count}</span></div>
          )) : <p className="empty">No findings yet.</p>}
        </section>
      </div>

      {repos.length > 0 && (
        <section className="panel" style={{ marginTop: 20 }}>
          <h3>Most active repositories</h3>
          {repos.map((r) => <div className="catrow" key={r.name} style={{ gridTemplateColumns: '1fr 60px' }}><span className="mono">{r.name}</span><span className="num">{r.reviews} reviews</span></div>)}
        </section>
      )}
    </>
  );
}
