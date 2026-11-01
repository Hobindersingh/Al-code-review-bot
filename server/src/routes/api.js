import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Review } from '../models/Review.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'invalid id');

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['processing', 'completed', 'failed', 'skipped', 'superseded']).optional(),
  q: z.string().max(100).optional(),
});
const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const feedbackBody = z.object({ value: z.enum(['helpful', 'not_helpful']).nullable() });

const sumCond = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const ZERO_TOTALS = { reviews: 0, completed: 0, failed: 0, findings: 0, tokens: 0, avgDurationMs: 0 };

export function buildStatsPipeline(since) {
  const findingsSize = { $size: { $ifNull: ['$findings', []] } };
  return [
    { $match: { createdAt: { $gte: since } } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              reviews: { $sum: 1 },
              completed: sumCond({ $eq: ['$status', 'completed'] }),
              failed: sumCond({ $eq: ['$status', 'failed'] }),
              findings: { $sum: findingsSize },
              tokens: { $sum: { $add: [{ $ifNull: ['$stats.promptTokens', 0] }, { $ifNull: ['$stats.completionTokens', 0] }] } },
              avgDurationMs: { $avg: '$stats.durationMs' },
            },
          },
        ],
        daily: [
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, reviews: { $sum: 1 }, findings: { $sum: findingsSize } } },
          { $sort: { _id: 1 } },
        ],
        severity: [{ $unwind: '$findings' }, { $group: { _id: '$findings.severity', count: { $sum: 1 } } }],
        category: [{ $unwind: '$findings' }, { $group: { _id: '$findings.category', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        feedback: [
          { $unwind: '$findings' },
          { $match: { 'findings.feedback': { $in: ['helpful', 'not_helpful'] } } },
          { $group: { _id: '$findings.feedback', count: { $sum: 1 } } },
        ],
        repos: [{ $group: { _id: '$repoFullName', reviews: { $sum: 1 } } }, { $sort: { reviews: -1 } }, { $limit: 5 }],
      },
    },
  ];
}

/** Fill days with no reviews so the chart x-axis is continuous. */
export function fillDays(rows, days, now = new Date()) {
  const map = new Map(rows.map((r) => [r._id, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, reviews: map.get(d)?.reviews ?? 0, findings: map.get(d)?.findings ?? 0 });
  }
  return out;
}

export function createApiRouter() {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  router.get('/stats', wrap(async (req, res) => {
    const { days } = statsQuery.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const [facets] = await Review.aggregate(buildStatsPipeline(since));
    const totals = { ...ZERO_TOTALS, ...(facets.totals[0] ?? {}) };
    delete totals._id;
    const fb = Object.fromEntries(facets.feedback.map((f) => [f._id, f.count]));
    const rated = (fb.helpful ?? 0) + (fb.not_helpful ?? 0);
    res.json({
      days,
      totals: { ...totals, avgDurationMs: Math.round(totals.avgDurationMs ?? 0) },
      acceptanceRate: rated ? (fb.helpful ?? 0) / rated : null,
      ratedFindings: rated,
      daily: fillDays(facets.daily, Math.min(days, 90)),
      severity: facets.severity.map((s) => ({ name: s._id, count: s.count })),
      category: facets.category.map((c) => ({ name: c._id, count: c.count })),
      repos: facets.repos.map((r) => ({ name: r._id, reviews: r.reviews })),
    });
  }));

  router.get('/reviews', wrap(async (req, res) => {
    const { page, limit, status, q } = listQuery.parse(req.query);
    const filter = {};
    if (status) filter.status = status;
    if (q) filter.$or = [{ repoFullName: new RegExp(escapeRegex(q), 'i') }, { title: new RegExp(escapeRegex(q), 'i') }];
    const [items, total] = await Promise.all([
      Review.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            repoFullName: 1, prNumber: 1, headSha: 1, title: 1, author: 1, status: 1, skipReason: 1, createdAt: 1, dryRun: 1,
            findingsCount: { $size: { $ifNull: ['$findings', []] } },
            urgentCount: { $size: { $filter: { input: { $ifNull: ['$findings', []] }, cond: { $in: ['$$this.severity', ['critical', 'high']] } } } },
          },
        },
      ]),
      Review.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  }));

  router.get('/reviews/:id', wrap(async (req, res) => {
    const id = objectId.parse(req.params.id);
    const doc = await Review.findById(id).lean();
    if (!doc) return res.status(404).json({ error: 'not found' });
    return res.json(doc);
  }));

  router.post('/reviews/:id/findings/:findingId/feedback', wrap(async (req, res) => {
    const id = objectId.parse(req.params.id);
    const findingId = objectId.parse(req.params.findingId);
    const { value } = feedbackBody.parse(req.body);
    const result = await Review.updateOne({ _id: id, 'findings._id': findingId }, { $set: { 'findings.$.feedback': value } });
    if (!result.matchedCount) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, value });
  }));

  return router;
}
