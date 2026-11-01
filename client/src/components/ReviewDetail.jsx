import { useState } from 'react';
import { api } from '../api.js';

function Finding({ reviewId, f, onChange }) {
  const [busy, setBusy] = useState(false);
  const vote = async (value) => {
    const next = f.feedback === value ? null : value;
    setBusy(true);
    try { await api(`/reviews/${reviewId}/findings/${f._id}/feedback`, { method: 'POST', body: { value: next } }); onChange(f._id, next); }
    finally { setBusy(false); }
  };
  return (
    <article className={`finding ${f.severity}`}>
      <div className="finding-head"><span className="mono">{f.path}:{f.line}</span><span>{f.severity}, {f.category}, {Math.round(f.confidence * 100)}% confident{f.placement === 'summary' ? ', not on a changed line' : ''}</span></div>
      <h3>{f.title}</h3>
      <p>{f.body}</p>
      {f.suggestion && <pre className="suggest">{f.suggestion}</pre>}
      <div className="fb">
        <span>Was this useful?</span>
        <button disabled={busy} aria-pressed={f.feedback === 'helpful'} onClick={() => vote('helpful')}>Helpful</button>
        <button disabled={busy} aria-pressed={f.feedback === 'not_helpful'} onClick={() => vote('not_helpful')}>Not helpful</button>
      </div>
    </article>
  );
}

export default function ReviewDetail({ review, onBack, onFeedback }) {
  const s = review.stats ?? {};
  return (
    <>
      <div className="main-head">
        <div>
          <button className="link" onClick={onBack}>Back to overview</button>
          <h2>{review.title}</h2>
          <div className="detail-meta">
            <span className="mono">{review.repoFullName}#{review.prNumber}</span>
            <span>by {review.author}</span>
            <span className="mono">{review.headSha.slice(0, 7)}</span>
            <span className={`pill ${review.status}`}>{review.status}{review.dryRun ? ' (dry run)' : ''}</span>
            {s.durationMs ? <span>{(s.durationMs / 1000).toFixed(1)}s, {s.iterations} model turns, {s.toolCalls} tool calls</span> : null}
            {s.promptTokens ? <span>{(s.promptTokens + s.completionTokens).toLocaleString()} tokens</span> : null}
          </div>
        </div>
      </div>
      {review.error && <div className="notice error" style={{ marginBottom: 20 }}><h3>This review failed</h3><p>{review.error}</p></div>}
      {review.skipReason && <div className="notice" style={{ marginBottom: 20 }}><p>Skipped: {review.skipReason}.</p></div>}
      {review.summary && <p className="summary">{review.summary}</p>}
      {review.findings?.length
        ? review.findings.map((f) => <Finding key={f._id} reviewId={review._id} f={f} onChange={onFeedback} />)
        : review.status === 'completed' && <div className="notice"><p>No findings. The agent found nothing worth raising on this commit.</p></div>}
    </>
  );
}
