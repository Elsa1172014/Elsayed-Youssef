/**
 * Fixed-window attempt limiter for login/registration. In-memory: per instance only, so behind multiple
 * instances move this to Redis (docs/DEPLOYMENT.md).
 */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Returns seconds to wait if blocked, otherwise 0. Does not count an attempt. */
  blockedFor(key: string): number {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= this.now()) return 0;
    return e.count >= this.max ? Math.ceil((e.resetAt - this.now()) / 1000) : 0;
  }

  fail(key: string): void {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    else e.count++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
