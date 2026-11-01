import { useCallback, useEffect, useState } from 'react';
import { AuthError, api, getKey, setKey } from './api.js';
import Overview from './components/Overview.jsx';
import ReviewDetail from './components/ReviewDetail.jsx';

const STATUSES = ['', 'completed', 'processing', 'failed', 'skipped', 'superseded'];
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function App() {
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState(null);
  const [list, setList] = useState({ items: [], total: 0, pages: 1 });
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(getKey());
  const dq = useDebounced(q);

  const fail = (e) => { if (e instanceof AuthError) setNeedsKey(true); else setError(e.message); };

  const load = useCallback(async (signal) => {
    try {
      const params = new URLSearchParams({ page, limit: 20, ...(status && { status }), ...(dq && { q: dq }) });
      const [s, l] = await Promise.all([api(`/stats?days=${days}`, { signal }), api(`/reviews?${params}`, { signal })]);
      setStats(s); setList(l); setError(null); setNeedsKey(false);
    } catch (e) { if (e.name !== 'AbortError') fail(e); }
  }, [days, page, status, dq]);

  useEffect(() => { setPage(1); }, [status, dq]);
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    const t = setInterval(() => load(ctrl.signal), 15000); // pick up newly queued reviews
    return () => { ctrl.abort(); clearInterval(t); };
  }, [load]);

  const open = async (id) => {
    try { setSelected(await api(`/reviews/${id}`)); } catch (e) { fail(e); }
  };
  const onFeedback = (fid, value) => setSelected((r) => ({ ...r, findings: r.findings.map((f) => (f._id === fid ? { ...f, feedback: value } : f)) }));

  return (
    <div className="shell">
      <aside className="inbox" aria-label="Reviews">
        <div className="inbox-head">
          <h1>Review ledger</h1>
          <div className="filters">
            <input type="search" placeholder="Search repo or title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reviews" />
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
            </select>
          </div>
        </div>
        <div className="list">
          {list.items.length === 0 && <p className="empty">{dq || status ? 'No reviews match these filters.' : 'No reviews yet.'}</p>}
          {list.items.map((r) => (
            <button key={r._id} className="row" aria-current={selected?._id === r._id} onClick={() => open(r._id)}>
              <div className="row-top"><span className="mono">{r.repoFullName}#{r.prNumber}</span><span>{ago(r.createdAt)}</span></div>
              <div className="row-title">{r.title}</div>
              <div className="row-meta">
                <span className={`pill ${r.status}`}>{r.status}</span>
                <span>{r.findingsCount} finding{r.findingsCount === 1 ? '' : 's'}</span>
                {r.urgentCount > 0 && <span className="urgent">{r.urgentCount} urgent</span>}
              </div>
            </button>
          ))}
        </div>
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>Page {page} of {list.pages}</span>
          <button disabled={page >= list.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </aside>

      <main className="main">
        {needsKey && (
          <div className="notice" style={{ marginBottom: 24 }}>
            <h3>Enter your dashboard API key</h3>
            <p>The server requires a key. It is stored only in this browser.</p>
            <div className="keybox">
              <input type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} aria-label="API key" />
              <button onClick={() => { setKey(keyDraft.trim()); load(); }}>Save key</button>
            </div>
          </div>
        )}
        {error && <div className="notice error" style={{ marginBottom: 24 }}><h3>Could not load data</h3><p>{error}. Check that the API server is running.</p></div>}

        {selected ? (
          <ReviewDetail review={selected} onBack={() => setSelected(null)} onFeedback={onFeedback} />
        ) : (
          <>
            <div className="main-head">
              <div><h2>Overview</h2><p>Automated pull request reviews, across all connected repositories.</p></div>
              <label className="range">Period <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select></label>
            </div>
            {stats ? <Overview stats={stats} days={days} /> : !error && !needsKey && <p className="empty">Loading…</p>}
          </>
        )}
      </main>
    </div>
  );
}
