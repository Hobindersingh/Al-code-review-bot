const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spaces calls at least 60000/rpm ms apart. The slot is reserved synchronously, so concurrent
 * callers queue up in order without races. rpm = 0 disables limiting.
 */
export function createRateLimiter(rpm) {
  if (!rpm) return async () => {};
  const gap = Math.ceil(60000 / rpm);
  let next = 0;
  return async function acquire() {
    const now = Date.now();
    const start = Math.max(now, next);
    next = start + gap;
    if (start > now) await sleep(start - now);
  };
}
