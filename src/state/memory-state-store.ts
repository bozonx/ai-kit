import type { Clock, StateStore } from '../ports.js';
import { systemClock } from '../ports.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * A `StateStore` inside one process.
 *
 * Enough for tests and for a single-instance deployment, and wrong for anything
 * else: with two processes behind a balancer each keeps its own idea of which
 * models are healthy. The point of shipping it is that the library can be used
 * before the consumer has wired Redis, not that it should stay this way.
 */
export class MemoryStateStore implements StateStore {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  public incr(key: string, ttlSec: number): Promise<number> {
    const current = Number.parseInt(this.read(key) ?? '0', 10);
    const next = (Number.isNaN(current) ? 0 : current) + 1;
    this.write(key, String(next), ttlSec);
    return Promise.resolve(next);
  }

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.read(key));
  }

  public set(key: string, value: string, ttlSec: number): Promise<void> {
    this.write(key, value, ttlSec);
    return Promise.resolve();
  }

  public compareAndSet(
    key: string,
    expected: string | null,
    next: string,
    ttlSec: number,
  ): Promise<boolean> {
    if (this.read(key) !== expected) return Promise.resolve(false);
    this.write(key, next, ttlSec);
    return Promise.resolve(true);
  }

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlSec: number): void {
    this.entries.set(key, { value, expiresAt: this.clock.now() + ttlSec * 1000 });
  }
}
