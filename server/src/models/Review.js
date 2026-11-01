import mongoose from 'mongoose';

const findingSchema = new mongoose.Schema(
  {
    path: String,
    line: Number,
    severity: { type: String, enum: ['critical', 'high', 'medium', 'low', 'info'] },
    category: String,
    confidence: Number,
    title: String,
    body: String,
    suggestion: String,
    placement: { type: String, enum: ['inline', 'summary'] },
    feedback: { type: String, enum: ['helpful', 'not_helpful', null], default: null },
  },
  { _id: true },
);

const reviewSchema = new mongoose.Schema(
  {
    repoFullName: { type: String, required: true },
    prNumber: { type: Number, required: true },
    headSha: { type: String, required: true },
    title: String,
    author: String,
    action: String,
    deliveryId: String,
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed', 'skipped', 'superseded'],
      default: 'processing',
    },
    skipReason: String,
    error: String,
    summary: String,
    githubReviewId: Number,
    dryRun: { type: Boolean, default: false },
    model: String,
    findings: [findingSchema],
    stats: {
      files: Number,
      additions: Number,
      deletions: Number,
      iterations: Number,
      toolCalls: Number,
      promptTokens: Number,
      completionTokens: Number,
      durationMs: Number,
      dropped: { type: Object },
    },
  },
  { timestamps: true },
);

// Layer 3 of idempotency: the database refuses a second review of the same commit.
reviewSchema.index({ repoFullName: 1, prNumber: 1, headSha: 1 }, { unique: true });
reviewSchema.index({ createdAt: -1 });
reviewSchema.index({ repoFullName: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: -1 });

export const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);
