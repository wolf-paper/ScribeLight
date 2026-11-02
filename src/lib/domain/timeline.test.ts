import { describe, expect, it } from 'vitest';
import {
  fitPixelsPerSecond,
  followScrollLeft,
  formatRulerTime,
  revealScrollLeft,
  rulerTicks,
  timeAtOffset,
  timelineContentWidth,
  zoomAround,
  zoomAtPointer
} from './timeline';

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

  it('zooms by an arbitrary factor around an anchor for the zoom buttons', () => {
    const next = zoomAround({ pixelsPerSecond: 100, scrollLeft: 0, viewportWidth: 500 }, 2, 250, 10_000);

    expect(next.pixelsPerSecond).toBe(200);
    expect(next.scrollLeft).toBe(250);
    expect(zoomAround(next, 0.5, 250, 10_000)).toEqual({ pixelsPerSecond: 100, scrollLeft: 0, viewportWidth: 500 });
  });

  it('reports the whole-clip fit zoom, capped at one pixel per millisecond', () => {
    expect(fitPixelsPerSecond(10_000, 500)).toBe(50);
    expect(fitPixelsPerSecond(100, 500)).toBe(1000);
    expect(fitPixelsPerSecond(0, 500)).toBe(0);
    expect(fitPixelsPerSecond(10_000, 0)).toBe(0);
  });
});

describe('timeAtOffset', () => {
  it('maps content pixels to clamped integer milliseconds', () => {
    expect(timeAtOffset(125.4, 100, 10_000)).toBe(1_254);
    expect(timeAtOffset(-20, 100, 10_000)).toBe(0);
    expect(timeAtOffset(5_000, 100, 10_000)).toBe(10_000);
    expect(timeAtOffset(Number.NaN, 100, 10_000)).toBe(0);
    expect(timeAtOffset(50, 0, 10_000)).toBe(0);
  });
});

describe('revealScrollLeft', () => {
  const window = { scrollLeft: 1_000, viewportWidth: 500, contentWidth: 10_000 };

  it('does not scroll when the range is already fully visible', () => {
    expect(revealScrollLeft(window, 1_000, 1_500)).toBeNull();
    expect(revealScrollLeft(window, 1_200, 1_300)).toBeNull();
  });

  it('centres a partly or fully hidden range', () => {
    expect(revealScrollLeft(window, 1_400, 1_600)).toBe(1_250);
    expect(revealScrollLeft(window, 5_000, 5_100)).toBe(4_800);
    expect(revealScrollLeft(window, 0, 100)).toBe(0);
    expect(revealScrollLeft(window, 9_900, 10_000)).toBe(9_500);
  });

  it('starts a range wider than the viewport near the left edge', () => {
    expect(revealScrollLeft(window, 3_000, 4_000)).toBe(2_975);
  });
});

describe('followScrollLeft', () => {
  const window = { scrollLeft: 1_000, viewportWidth: 500, contentWidth: 10_000 };

  it('leaves a visible playhead alone', () => {
    expect(followScrollLeft(window, 1_000)).toBeNull();
    expect(followScrollLeft(window, 1_500)).toBeNull();
  });

  it('pages so the playhead sits about 10% from the left edge once it leaves the window', () => {
    expect(followScrollLeft(window, 1_501)).toBeCloseTo(1_451);
    expect(followScrollLeft(window, 200)).toBe(150);
    expect(followScrollLeft(window, 9_990)).toBe(9_500);
    expect(followScrollLeft({ ...window, scrollLeft: 9_500 }, 10_001)).toBeNull();
  });
});

describe('rulerTicks', () => {
  it('labels ticks with minutes and keeps them at least 70 px apart inside the clip', () => {
    const ticks = rulerTicks(125_000, 10);

    expect(ticks.slice(0, 4)).toEqual([
      { ms: 0, label: '0:00' },
      { ms: 10_000, label: '0:10' },
      { ms: 20_000, label: '0:20' },
      { ms: 30_000, label: '0:30' }
    ]);
    expect(ticks.at(-1)).toEqual({ ms: 120_000, label: '2:00' });
    expect(ticks.every(({ ms }) => Number.isInteger(ms) && ms < 125_000)).toBe(true);
  });

  it('picks steps from the nice ladder for each zoom level', () => {
    const stepAt = (pixelsPerSecond: number) => rulerTicks(400_000, pixelsPerSecond)[1].ms;

    expect(stepAt(1000)).toBe(100);
    expect(stepAt(280)).toBe(250);
    expect(stepAt(140)).toBe(500);
    expect(stepAt(70)).toBe(1_000);
    expect(stepAt(30)).toBe(5_000);
    expect(stepAt(5)).toBe(15_000);
    expect(stepAt(2)).toBe(60_000);
    expect(stepAt(0.3)).toBe(300_000);
    for (const pixelsPerSecond of [1000, 280, 140, 70, 30, 5, 2, 0.3]) {
      expect(stepAt(pixelsPerSecond) / 1000 * pixelsPerSecond).toBeGreaterThanOrEqual(70);
    }
  });

  it('adds sub-second digits only when the step is below one second', () => {
    expect(rulerTicks(6_000, 140).map(({ label }) => label).slice(10, 12)).toEqual(['0:05', '0:05.5']);
    expect(rulerTicks(6_000, 280).map(({ label }) => label).slice(20, 24))
      .toEqual(['0:05', '0:05.25', '0:05.5', '0:05.75']);
    expect(rulerTicks(6_000, 1000).map(({ label }) => label).slice(50, 52)).toEqual(['0:05', '0:05.1']);
  });

  it('handles an empty clip and an unmeasured zoom without invalid ticks', () => {
    expect(rulerTicks(0, 100)).toEqual([{ ms: 0, label: '0:00' }]);
    expect(rulerTicks(1, 1000)).toEqual([{ ms: 0, label: '0:00' }]);
    expect(rulerTicks(10_000, 0)).toEqual([{ ms: 0, label: '0:00' }]);
  });
});

describe('formatRulerTime', () => {
  it('always shows minutes and switches to hours past one hour', () => {
    expect(formatRulerTime(5_000, 5_000)).toBe('0:05');
    expect(formatRulerTime(90_000, 30_000)).toBe('1:30');
    expect(formatRulerTime(720_000, 60_000)).toBe('12:00');
    expect(formatRulerTime(3_725_000, 5_000)).toBe('1:02:05');
  });

  it('shows only the fractional digits the step needs, without trailing zeros', () => {
    expect(formatRulerTime(5_500, 500)).toBe('0:05.5');
    expect(formatRulerTime(5_250, 250)).toBe('0:05.25');
    expect(formatRulerTime(5_000, 250)).toBe('0:05');
    expect(formatRulerTime(5_100, 100)).toBe('0:05.1');
  });
});
