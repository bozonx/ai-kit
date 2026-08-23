import { describe, it, expect } from '@jest/globals';

import { MemoryStateStore } from '../src/state/memory-state-store.js';
import type { Clock } from '../src/ports.js';

class FakeClock implements Clock {
  private current = 0;

  public now(): number {
    return this.current;
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

describe('MemoryStateStore', () => {
  it('counts up from nothing', async () => {
    const store = new MemoryStateStore(new FakeClock());

    expect(await store.incr('k', 60)).toBe(1);
    expect(await store.incr('k', 60)).toBe(2);
  });

  it('forgets a key once its ttl has passed', async () => {
    const clock = new FakeClock();
    const store = new MemoryStateStore(clock);

    await store.set('k', 'v', 10);
    clock.advance(9_999);
    expect(await store.get('k')).toBe('v');

    clock.advance(1);
    expect(await store.get('k')).toBeNull();
  });

  it('only swaps when the current value is the expected one', async () => {
    const store = new MemoryStateStore(new FakeClock());

    expect(await store.compareAndSet('circuit', null, 'OPEN', 60)).toBe(true);
    expect(await store.compareAndSet('circuit', null, 'CLOSED', 60)).toBe(false);
    expect(await store.compareAndSet('circuit', 'OPEN', 'HALF_OPEN', 60)).toBe(true);
    expect(await store.get('circuit')).toBe('HALF_OPEN');
  });

  it('treats an expired key as absent for compare-and-set', async () => {
    const clock = new FakeClock();
    const store = new MemoryStateStore(clock);

    await store.set('k', 'v', 1);
    clock.advance(2_000);

    expect(await store.compareAndSet('k', null, 'fresh', 60)).toBe(true);
  });
});
