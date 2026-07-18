import { describe, expect, it } from 'vitest';
import { rulerTicks, timelineContentWidth, zoomAtPointer } from './timeline';

describe('timeline zoom', () => {
  it('keeps the source time beneath the pointer fixed while zooming in', () => {
    const next = zoomAtPointer(
      { pixelsPerSecond: 100, scrollLeft: 100, viewportWidth: 500 },
      -100,
      250,
      10_000
    );

    expect(next.pixelsPerSecond).toBe(125);
    expect(next.scrollLeft).toBeCloseTo(187.5);
    expect((next.scrollLeft + 250) / next.pixelsPerSecond).toBeCloseTo(3.5);
  });

  it('does not zoom out beyond the whole-clip fit width', () => {
    const next = zoomAtPointer(
      { pixelsPerSecond: 100, scrollLeft: 0, viewportWidth: 500 },
      100,
      250,
      2_000
    );

    expect(next.pixelsPerSecond).toBe(250);
    expect(next.scrollLeft).toBe(0);
  });

  it('caps zoom at one pixel per millisecond', () => {
    const next = zoomAtPointer(
      { pixelsPerSecond: 950, scrollLeft: 9_000, viewportWidth: 300 },
      -1,
      250,
      20_000
    );

    expect(next.pixelsPerSecond).toBe(1000);
  });

  it('clamps scroll when pointer anchoring would exceed clip bounds', () => {
    const next = zoomAtPointer(
      { pixelsPerSecond: 100, scrollLeft: 980, viewportWidth: 500 },
      -1,
      500,
      10_000
    );

    expect(next.scrollLeft).toBe(750);
  });

  it('keeps zero and invalid geometry finite and safe', () => {
    const next = zoomAtPointer(
      { pixelsPerSecond: Number.NaN, scrollLeft: Number.POSITIVE_INFINITY, viewportWidth: 0 },
      -1,
      Number.NaN,
      0
    );

    expect(next.pixelsPerSecond).toBeGreaterThanOrEqual(0);
    expect(next.pixelsPerSecond).toBeLessThanOrEqual(1000);
    expect(Number.isFinite(next.pixelsPerSecond)).toBe(true);
    expect(Number.isFinite(next.scrollLeft)).toBe(true);
    expect(timelineContentWidth(0, next.pixelsPerSecond)).toBe(0);
  });
});

describe('rulerTicks', () => {
  it('returns integer-millisecond ticks at readable density including both clip ends', () => {
    const ticks = rulerTicks(2_345, 100);

    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(2_345);
    expect(ticks.every(Number.isInteger)).toBe(true);
    expect(ticks.slice(0, -1).every((tick, index) => index === 0 || tick - ticks[index - 1] >= 700)).toBe(true);
  });

  it('handles a tiny or empty clip without producing invalid ticks', () => {
    expect(rulerTicks(0, 100)).toEqual([0]);
    expect(rulerTicks(1, 1000)).toEqual([0, 1]);
  });
});
