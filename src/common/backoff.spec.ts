import { describe, expect, it } from 'vitest';

import { exponentialBackoffMs } from './backoff.js';

describe('exponentialBackoffMs', () => {
  it('dobra a cada tentativa sem jitter', () => {
    expect([1, 2, 3, 4].map((n) => exponentialBackoffMs(n, 1000, 60_000, 0))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('respeita o teto', () => {
    expect(exponentialBackoffMs(50, 1000, 60_000, 0)).toBe(60_000);
  });

  it('aplica jitter dentro da faixa', () => {
    expect(exponentialBackoffMs(1, 1000, 60_000, 0.2, () => 0)).toBe(800);
    expect(exponentialBackoffMs(1, 1000, 60_000, 0.2, () => 1)).toBe(1200);
  });
});
