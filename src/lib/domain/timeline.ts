export interface ZoomState {
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}

/** Horizontal geometry of the scrolling timeline viewport, in CSS pixels. */
export interface ScrollWindow {
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}

export interface RulerTick {
  ms: number;
  label: string;
}

export const MAX_PIXELS_PER_SECOND = 1000;
const DEFAULT_PIXELS_PER_SECOND = 100;
const WHEEL_ZOOM_FACTOR = 1.25;
/** Fraction of the viewport kept to the left of the playhead after a follow page turn. */
const FOLLOW_LEAD = 0.1;
/** Fraction of the viewport kept to the left of a revealed range that is wider than the viewport. */
const REVEAL_LEAD = 0.05;
const MIN_TICK_SPACING_PX = 70;
const MAX_TICKS = 5_000;
const HOUR_MS = 3_600_000;
const TICK_STEPS_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, HOUR_MS
];

function nonNegativeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function safeDurationMs(durationMs: number): number {
  return Math.round(nonNegativeFinite(durationMs));
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function timelineContentWidth(durationMs: number, pixelsPerSecond: number): number {
  return safeDurationMs(durationMs) / 1000 * nonNegativeFinite(pixelsPerSecond);
}

/** Zoom level at which the whole clip fits the viewport (0 while either is unmeasurable). */
export function fitPixelsPerSecond(durationMs: number, viewportWidth: number): number {
  const duration = safeDurationMs(durationMs);
  const width = nonNegativeFinite(viewportWidth);
  return duration > 0 && width > 0 ? Math.min(MAX_PIXELS_PER_SECOND, width * 1000 / duration) : 0;
}

/**
 * Multiplies the zoom by `factor`, clamped between the whole-clip fit and one pixel per
 * millisecond, keeping the source time beneath `anchorX` (viewport-relative) fixed.
 */
export function zoomAround(
  state: ZoomState,
  factor: number,
  anchorX: number,
  durationMs: number
): ZoomState {
  const duration = safeDurationMs(durationMs);
  const viewportWidth = nonNegativeFinite(state.viewportWidth);
  const fit = fitPixelsPerSecond(duration, viewportWidth);
  const currentPixelsPerSecond = clamp(
    nonNegativeFinite(state.pixelsPerSecond, DEFAULT_PIXELS_PER_SECOND),
    fit,
    MAX_PIXELS_PER_SECOND
  );
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const pixelsPerSecond = clamp(currentPixelsPerSecond * safeFactor, fit, MAX_PIXELS_PER_SECOND);
  const currentContentWidth = timelineContentWidth(duration, currentPixelsPerSecond);
  const currentScrollMax = Math.max(0, currentContentWidth - viewportWidth);
  const currentScrollLeft = clamp(nonNegativeFinite(state.scrollLeft), 0, currentScrollMax);
  const localAnchorX = clamp(nonNegativeFinite(anchorX), 0, viewportWidth);
  const anchorSeconds = currentPixelsPerSecond > 0
    ? (currentScrollLeft + localAnchorX) / currentPixelsPerSecond
    : 0;
  const contentWidth = timelineContentWidth(duration, pixelsPerSecond);
  const scrollLeft = clamp(
    anchorSeconds * pixelsPerSecond - localAnchorX,
    0,
    Math.max(0, contentWidth - viewportWidth)
  );

  return { pixelsPerSecond, scrollLeft, viewportWidth };
}

/** Ctrl+wheel zoom: one notch in (`deltaY < 0`) or out (`deltaY > 0`) around the pointer. */
export function zoomAtPointer(
  state: ZoomState,
  deltaY: number,
  pointerX: number,
  durationMs: number
): ZoomState {
  const factor = deltaY < 0 ? WHEEL_ZOOM_FACTOR : deltaY > 0 ? 1 / WHEEL_ZOOM_FACTOR : 1;
  return zoomAround(state, factor, pointerX, durationMs);
}

/** Integer clip time under a content-relative x offset, clamped to the clip. */
export function timeAtOffset(offsetPx: number, pixelsPerSecond: number, durationMs: number): number {
  const duration = safeDurationMs(durationMs);
  const pixels = nonNegativeFinite(pixelsPerSecond);
  if (duration === 0 || pixels === 0 || !Number.isFinite(offsetPx)) return 0;
  return clamp(Math.round(offsetPx / pixels * 1000), 0, duration);
}

/**
 * Scroll position that brings `[startPx, endPx]` into view: `null` when it is already fully
 * visible, otherwise centred (or, when wider than the viewport, started near the left edge).
 */
export function revealScrollLeft(window: ScrollWindow, startPx: number, endPx: number): number | null {
  const viewportWidth = nonNegativeFinite(window.viewportWidth);
  if (viewportWidth === 0 || !Number.isFinite(startPx) || !Number.isFinite(endPx)) return null;
  const start = Math.min(startPx, endPx);
  const end = Math.max(startPx, endPx);
  const scrollLeft = nonNegativeFinite(window.scrollLeft);
  if (start >= scrollLeft && end <= scrollLeft + viewportWidth) return null;
  const target = end - start <= viewportWidth
    ? (start + end) / 2 - viewportWidth / 2
    : start - viewportWidth * REVEAL_LEAD;
  return clamp(target, 0, Math.max(0, nonNegativeFinite(window.contentWidth) - viewportWidth));
}

/**
 * Page turn for playback follow: `null` while the playhead is visible, otherwise the scroll
 * position that puts the playhead about 10% from the left edge.
 */
export function followScrollLeft(window: ScrollWindow, playheadPx: number): number | null {
  const viewportWidth = nonNegativeFinite(window.viewportWidth);
  if (viewportWidth === 0 || !Number.isFinite(playheadPx)) return null;
  const scrollLeft = nonNegativeFinite(window.scrollLeft);
  if (playheadPx >= scrollLeft && playheadPx <= scrollLeft + viewportWidth) return null;
  const scrollMax = Math.max(0, nonNegativeFinite(window.contentWidth) - viewportWidth);
  const target = clamp(playheadPx - viewportWidth * FOLLOW_LEAD, 0, scrollMax);
  return Math.abs(target - scrollLeft) < 0.5 ? null : target;
}

function rulerStepMs(durationMs: number, pixelsPerSecond: number): number {
  const pixels = nonNegativeFinite(pixelsPerSecond);
  const minimumStepMs = Math.max(
    pixels > 0 ? MIN_TICK_SPACING_PX * 1000 / pixels : durationMs,
    durationMs / MAX_TICKS
  );
  return TICK_STEPS_MS.find((step) => step >= minimumStepMs)
    ?? Math.ceil(minimumStepMs / HOUR_MS) * HOUR_MS;
}

/**
 * Formats a ruler position as `m:ss` (`h:mm:ss` from one hour), adding only the fractional
 * digits the tick step needs, without trailing zeros: `0:05`, `0:05.5`, `0:05.25`.
 */
export function formatRulerTime(milliseconds: number, stepMs: number): string {
  const safe = Math.round(nonNegativeFinite(milliseconds));
  const step = Math.round(nonNegativeFinite(stepMs));
  const digits = step % 1000 === 0 ? 0 : step % 100 === 0 ? 1 : step % 10 === 0 ? 2 : 3;
  const fraction = String(safe % 1000).padStart(3, '0').slice(0, digits).replace(/0+$/, '');
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${Math.floor(totalSeconds / 60)}:${seconds}`;
  return fraction ? `${clock}.${fraction}` : clock;
}

/**
 * Labelled ruler ticks at a step from a fixed ladder (0.1 s … 1 h) chosen so labels stay at
 * least ~70 px apart. Ticks start at 0 and stay inside the clip.
 */
export function rulerTicks(durationMs: number, pixelsPerSecond: number): RulerTick[] {
  const duration = safeDurationMs(durationMs);
  const step = rulerStepMs(duration, pixelsPerSecond);
  const ticks: RulerTick[] = [];
  for (let ms = 0; ms === 0 || ms < duration; ms += step) {
    ticks.push({ ms, label: formatRulerTime(ms, step) });
  }
  return ticks;
}
