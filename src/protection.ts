import { AppError } from "./utils";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  assertAllowed(key: string, now = Date.now()): void {
    const current = this.entries.get(key);

    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }

    if (current.count >= this.maxRequests) {
      throw new AppError(429, "Too many requests. Try again later.", "RATE_LIMITED");
    }

    current.count += 1;
  }
}

interface CachedResult<T> {
  expiresAt: number;
  result: T;
}

export class InMemoryTicketDeduplicator<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly completed = new Map<string, CachedResult<T>>();

  constructor(private readonly ttlMs: number) {}

  async run(key: string, operation: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.completed.get(key);

    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    if (cached) {
      this.completed.delete(key);
    }

    const existing = this.inFlight.get(key);

    if (existing) {
      return existing;
    }

    const task = operation()
      .then((result) => {
        this.completed.set(key, { result, expiresAt: Date.now() + this.ttlMs });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, task);
    return task;
  }
}
