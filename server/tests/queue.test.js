import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueReview, buildJobId } from '../src/services/queue.js';

const data = { repoFullName: 'o/r', prNumber: 1, headSha: 'abc' };
function fakeQueue(state) {
  const log = { removed: 0, added: [] };
  return { log, async getJob() { return state ? { async getState() { return state; }, async remove() { log.removed += 1; } } : null; }, async add(n, d, o) { log.added.push(o.jobId); return { id: o.jobId }; } };
}

test('active/waiting jobs are left alone (layer 2 dedupe is delegated to BullMQ)', async () => {
  for (const st of ['active', 'waiting', 'delayed']) { const q = fakeQueue(st); await enqueueReview(q, data); assert.equal(q.log.removed, 0, st); assert.deepEqual(q.log.added, [buildJobId(data)]); }
});
test('failed/completed jobs are cleared so a redelivery can run again', async () => {
  for (const st of ['failed', 'completed']) { const q = fakeQueue(st); await enqueueReview(q, data); assert.equal(q.log.removed, 1, st); }
});
test('no existing job: plain add', async () => { const q = fakeQueue(null); await enqueueReview(q, data); assert.equal(q.log.added.length, 1); });
