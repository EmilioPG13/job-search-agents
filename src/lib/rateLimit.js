// Pace requests to stay inside NVIDIA NIM's free-tier limit.
//
// The limit is roughly 40 requests per minute, applied to the API key as a
// whole rather than per model — so running two agents at once shares one
// budget. Exceeding it returns 429.
//
// This waits before a request rather than retrying after a rejection. Retrying
// a 429 on a service where a single call can take a minute means paying that
// minute twice; queuing for a slot costs only the wait.
//
// Slow is not the same as failed here. A NIM request routinely takes 30-170
// seconds and still succeeds — the pipeline is throughput-bound, not
// latency-bound, so the job is to keep a steady stream of requests in flight
// without tripping the ceiling.

// Set below the documented 40 so bursts and clock skew don't reach it.
const DEFAULT_LIMIT = Number(process.env.NIM_RPM_LIMIT) || 32;
const WINDOW_MS = 60_000;

class RateLimiter {
  constructor(limitPerMinute = DEFAULT_LIMIT) {
    this.limit = limitPerMinute;
    /** Start times of requests inside the current window. */
    this.recent = [];
    /** Serialises waiters so they can't all wake and fire at once. */
    this.chain = Promise.resolve();
    this.stats = { granted: 0, totalWaitMs: 0, longestWaitMs: 0 };
  }

  /** Drop timestamps that have aged out of the window. */
  _prune(now) {
    const cutoff = now - WINDOW_MS;
    while (this.recent.length && this.recent[0] <= cutoff) this.recent.shift();
  }

  /**
   * Resolve when it is safe to send another request.
   *
   * Calls queue behind each other, so ten concurrent callers are released in
   * order rather than all checking the same stale count and going at once.
   */
  acquire() {
    const wait = this.chain.then(async () => {
      const started = Date.now();

      for (;;) {
        const now = Date.now();
        this._prune(now);

        if (this.recent.length < this.limit) {
          this.recent.push(now);
          const waited = now - started;
          this.stats.granted++;
          this.stats.totalWaitMs += waited;
          this.stats.longestWaitMs = Math.max(this.stats.longestWaitMs, waited);
          return waited;
        }

        // Sleep until the oldest request leaves the window, plus a little.
        const sleepFor = this.recent[0] + WINDOW_MS - now + 50;
        await new Promise((r) => setTimeout(r, Math.max(sleepFor, 25)));
      }
    });

    // The chain must not break on a rejected caller.
    this.chain = wait.then(
      () => undefined,
      () => undefined,
    );
    return wait;
  }

  /** Requests started in the last minute — what the limit actually counts. */
  currentRate() {
    this._prune(Date.now());
    return this.recent.length;
  }

  report() {
    const { granted, totalWaitMs, longestWaitMs } = this.stats;
    return {
      granted,
      averageWaitMs: granted ? Math.round(totalWaitMs / granted) : 0,
      longestWaitMs,
      limit: this.limit,
    };
  }
}

// One limiter per process. The quota is per API key, so separate limiters
// would each think they had the whole budget.
const shared = new RateLimiter();

module.exports = { RateLimiter, shared, DEFAULT_LIMIT };
