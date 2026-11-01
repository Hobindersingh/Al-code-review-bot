/**
 * Layer 1 of idempotency: GitHub retries/redelivers with the same X-GitHub-Delivery id.
 * SET NX makes the "have I seen this?" check atomic across API replicas.
 */
export function createIdempotency(redis, { ttlSeconds = 7 * 24 * 3600, prefix = 'aicr:delivery:' } = {}) {
  return {
    async claim(deliveryId) {
      const res = await redis.set(`${prefix}${deliveryId}`, '1', 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    },
    /** Called if enqueueing fails so a redelivery of the same event is not wrongly dropped. */
    async release(deliveryId) {
      await redis.del(`${prefix}${deliveryId}`);
    },
  };
}
