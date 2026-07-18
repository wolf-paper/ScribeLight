export interface ZoomState {
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
}

const MAX_PIXELS_PER_SECOND = 1000;
const DEFAULT_PIXELS_PER_SECOND = 100;

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

export function zoomAtPointer(
  state: ZoomState,
  deltaY: number,
  pointerX: number,
  durationMs: number
): ZoomState {
  const duration = safeDurationMs(durationMs);
  const viewportWidth = nonNegativeFinite(state.viewportWidth);
  const fitPixelsPerSecond = duration > 0 && viewportWidth > 0
    ? Math.min(MAX_PIXELS_PER_SECOND, viewportWidth * 1000 / duration)
    : 0;
  const currentPixelsPerSecond = clamp(
    nonNegativeFinite(state.pixelsPerSecond, DEFAULT_PIXELS_PER_SECOND),
    fitPixelsPerSecond,
    MAX_PIXELS_PER_SECOND
  );
  const factor = deltaY < 0 ? 1.25 : deltaY > 0 ? 0.8 : 1;
  const pixelsPerSecond = clamp(
    currentPixelsPerSecond * factor,
    fitPixelsPerSecond,
    MAX_PIXELS_PER_SECOND
  );
  const currentContentWidth = timelineContentWidth(duration, currentPixelsPerSecond);
  const currentScrollMax = Math.max(0, currentContentWidth - viewportWidth);
  const currentScrollLeft = clamp(nonNegativeFinite(state.scrollLeft), 0, currentScrollMax);
  const localPointerX = clamp(nonNegativeFinite(pointerX), 0, viewportWidth);
  const anchorSeconds = currentPixelsPerSecond > 0
    ? (currentScrollLeft + localPointerX) / currentPixelsPerSecond
    : 0;
  const contentWidth = timelineContentWidth(duration, pixelsPerSecond);
  const scrollLeft = clamp(
    anchorSeconds * pixelsPerSecond - localPointerX,
    0,
    Math.max(0, contentWidth - viewportWidth)
  );

  return { pixelsPerSecond, scrollLeft, viewportWidth };
}

function niceStepAtLeast(minimumMs: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, minimumMs)));
  for (const multiplier of [1, 2, 5, 10]) {
    const step = multiplier * magnitude;
    if (step >= minimumMs) return Math.round(step);
  }
  return Math.round(10 * magnitude);
}

export function rulerTicks(durationMs: number, pixelsPerSecond: number): number[] {
  const duration = safeDurationMs(durationMs);
  if (duration === 0) return [0];

  const pixels = nonNegativeFinite(pixelsPerSecond);
  const minimumStepMs = Math.max(pixels > 0 ? 70_000 / pixels : duration, duration / 5_000);
  const stepMs = Math.max(1, niceStepAtLeast(minimumStepMs));
  const ticks = [0];

  for (let tick = stepMs; tick < duration; tick += stepMs) {
    ticks.push(tick);
  }
  if (ticks.at(-1) !== duration) ticks.push(duration);
  return ticks;
}
