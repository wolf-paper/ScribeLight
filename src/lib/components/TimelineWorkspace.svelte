<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { PeakData } from '../bridge/native';
  import type { Selection } from '../domain/types';
  import type { WaveformAnnotation } from '../waveform/wavesurferAdapter';
  import {
    MAX_PIXELS_PER_SECOND,
    fitPixelsPerSecond,
    followScrollLeft,
    revealScrollLeft,
    timeAtOffset,
    timelineContentWidth,
    zoomAround,
    zoomAtPointer
  } from '../domain/timeline';
  import LoopSelectionBar from './LoopSelectionBar.svelte';
  import TimeRuler from './TimeRuler.svelte';
  import WaveformView from './WaveformView.svelte';

  export let durationMs: number;
  export let selection: Selection | null;
  /** The current selection was resized or moved (waveform region edges/body or loop bar). */
  export let onchange: (selection: Selection) => void;
  /** A new range was dragged out on the waveform. */
  export let oncreate: (selection: Selection) => void;
  /** Click on the waveform background or ruler, or a ruler/playhead scrub. */
  export let onseek: (milliseconds: number) => void;
  export let peaks: PeakData | null = null;
  export let playheadMs = 0;
  export let playing = false;
  /** Scrolls `[startMs, endMs]` into view whenever `key` changes. */
  export let reveal: { startMs: number; endMs: number; key: number } | null = null;
  export let annotations: readonly WaveformAnnotation[] = [];
  export let activeAnnotationId: string | null = null;
  export let previewAnnotationId: string | null = null;
  export let onannotationpreview: (annotationId: string, previewing: boolean) => void;
  export let onannotationactivate: (annotationId: string) => void;
  export let disabled = false;

  /** Playback follow leaves the view alone this long after a manual scroll. */
  const manualScrollHoldMs = 1_500;
  const buttonZoomFactor = 2;

  interface Scrub {
    pointerId: number;
    frame: number | null;
    pendingMs: number | null;
  }

  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let pixelsPerSecond = 100;
  let viewportWidth = 0;
  let pendingScrollLeft: number | null = null;
  let scrollGeneration = 0;
  let programmaticScrollLeft: number | null = null;
  let manualScrollAt = Number.NEGATIVE_INFINITY;
  let handledRevealKey: number | null = null;
  let scrub: Scrub | null = null;

  $: contentWidth = timelineContentWidth(durationMs, pixelsPerSecond);
  $: scrollSurfaceWidth = Math.max(viewportWidth, contentWidth);
  $: playheadX = Math.min(
    contentWidth,
    Math.max(0, Number.isFinite(playheadMs) ? playheadMs / 1000 * pixelsPerSecond : 0)
  );
  $: fitZoom = fitPixelsPerSecond(durationMs, viewportWidth);
  $: canZoomIn = !disabled && durationMs > 0 && pixelsPerSecond < MAX_PIXELS_PER_SECOND;
  $: canZoomOut = !disabled && fitZoom > 0 && pixelsPerSecond > fitZoom;
  $: if (reveal && viewport && viewportWidth > 0 && reveal.key !== handledRevealKey) revealRange(reveal);
  $: followPlayhead(playing, playheadX);

  function currentScrollLeft(): number {
    return pendingScrollLeft ?? viewport.scrollLeft;
  }

  function scheduleScrollAfterRender(target: number): void {
    pendingScrollLeft = target;
    const generation = ++scrollGeneration;
    void applyScrollAfterRender(generation, target);
  }

  function measureViewport(): void {
    viewportWidth = viewport && Number.isFinite(viewport.clientWidth) ? Math.max(0, viewport.clientWidth) : 0;
    if (!viewport) return;
    const scrollLeft = currentScrollLeft();
    const next = zoomAtPointer({ pixelsPerSecond, scrollLeft, viewportWidth }, 0, 0, durationMs);
    pixelsPerSecond = next.pixelsPerSecond;
    if (next.scrollLeft !== scrollLeft) scheduleScrollAfterRender(next.scrollLeft);
  }

  async function applyScrollAfterRender(generation: number, target: number): Promise<void> {
    await tick();
    if (generation !== scrollGeneration || !viewport || pendingScrollLeft !== target) return;
    viewport.scrollLeft = target;
    programmaticScrollLeft = viewport.scrollLeft;
    pendingScrollLeft = null;
  }

  function noteScroll(): void {
    if (programmaticScrollLeft !== null && Math.abs(viewport.scrollLeft - programmaticScrollLeft) <= 1) return;
    programmaticScrollLeft = null;
    manualScrollAt = Date.now();
  }

  function revealRange(next: { startMs: number; endMs: number; key: number }): void {
    handledRevealKey = next.key;
    const target = revealScrollLeft(
      { scrollLeft: currentScrollLeft(), viewportWidth, contentWidth },
      next.startMs / 1000 * pixelsPerSecond,
      next.endMs / 1000 * pixelsPerSecond
    );
    if (target !== null) scheduleScrollAfterRender(target);
  }

  function followPlayhead(active: boolean, x: number): void {
    if (!active || !viewport || viewportWidth <= 0) return;
    if (Date.now() - manualScrollAt < manualScrollHoldMs) return;
    const target = followScrollLeft({ scrollLeft: currentScrollLeft(), viewportWidth, contentWidth }, x);
    if (target !== null) scheduleScrollAfterRender(target);
  }

  onMount(() => {
    measureViewport();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureViewport);
    observer?.observe(viewport);
    window.addEventListener('resize', measureViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureViewport);
    };
  });

  onDestroy(() => stopScrub(false));

  function wheel(event: WheelEvent): void {
    if (disabled || !event.ctrlKey || !viewport) return;
    event.preventDefault();
    measureViewport();
    const bounds = viewport.getBoundingClientRect();
    const next = zoomAtPointer(
      { pixelsPerSecond, scrollLeft: currentScrollLeft(), viewportWidth },
      event.deltaY,
      event.clientX - bounds.left,
      durationMs
    );
    pixelsPerSecond = next.pixelsPerSecond;
    scheduleScrollAfterRender(next.scrollLeft);
  }

  /** Button zoom keeps a visible playhead in place, otherwise the viewport centre. */
  function zoomBy(factor: number): void {
    if (disabled || !viewport) return;
    measureViewport();
    const scrollLeft = currentScrollLeft();
    const playheadOffset = playheadX - scrollLeft;
    const anchor = playheadOffset >= 0 && playheadOffset <= viewportWidth ? playheadOffset : viewportWidth / 2;
    const next = zoomAround({ pixelsPerSecond, scrollLeft, viewportWidth }, factor, anchor, durationMs);
    pixelsPerSecond = next.pixelsPerSecond;
    scheduleScrollAfterRender(next.scrollLeft);
  }

  function fitWholeClip(): void {
    if (disabled || !viewport) return;
    measureViewport();
    const fit = fitPixelsPerSecond(durationMs, viewportWidth);
    if (fit <= 0) return;
    pixelsPerSecond = fit;
    scheduleScrollAfterRender(0);
  }

  function timeAtClientX(clientX: number): number {
    return timeAtOffset(clientX - content.getBoundingClientRect().left, pixelsPerSecond, durationMs);
  }

  /** Ruler presses seek at once; playhead-grip presses only move with the pointer. */
  function beginScrub(event: PointerEvent, seekAtPress: boolean): void {
    if (disabled || event.button !== 0 || !content || durationMs <= 0) return;
    event.preventDefault();
    stopScrub(false);
    const target = event.currentTarget;
    if (target instanceof Element && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Capture is unavailable in some embedded/test environments; window listeners still track the drag.
      }
    }
    scrub = { pointerId: event.pointerId, frame: null, pendingMs: null };
    window.addEventListener('pointermove', moveScrub);
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    if (seekAtPress) onseek(timeAtClientX(event.clientX));
  }

  function moveScrub(event: PointerEvent): void {
    if (!scrub || event.pointerId !== scrub.pointerId) return;
    scrub.pendingMs = timeAtClientX(event.clientX);
    scrub.frame ??= requestAnimationFrame(flushScrub);
  }

  function flushScrub(): void {
    if (!scrub) return;
    scrub.frame = null;
    const milliseconds = scrub.pendingMs;
    scrub.pendingMs = null;
    if (milliseconds !== null) onseek(milliseconds);
  }

  function endScrub(event: PointerEvent): void {
    if (scrub && event.pointerId === scrub.pointerId) stopScrub(true);
  }

  function stopScrub(flush: boolean): void {
    if (!scrub) return;
    if (scrub.frame !== null) cancelAnimationFrame(scrub.frame);
    if (flush) flushScrub();
    scrub = null;
    window.removeEventListener('pointermove', moveScrub);
    window.removeEventListener('pointerup', endScrub);
    window.removeEventListener('pointercancel', endScrub);
  }
</script>

<section class="timeline-workspace" data-testid="timeline-workspace" aria-label="Timeline">
  <div class="zoom-controls" role="group" aria-label="Timeline zoom">
    <button type="button" aria-label="Zoom out" title="Zoom out (or Ctrl + wheel down)" disabled={!canZoomOut} on:click={() => zoomBy(1 / buttonZoomFactor)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>
    </button>
    <button type="button" aria-label="Zoom in" title="Zoom in (or Ctrl + wheel up)" disabled={!canZoomIn} on:click={() => zoomBy(buttonZoomFactor)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" /></svg>
    </button>
    <button type="button" aria-label="Fit whole clip" title="Fit whole clip (Ctrl + wheel zooms)" disabled={!canZoomOut} on:click={fitWholeClip}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5v9M13.5 3.5v9M5 8h6M7 6 5 8l2 2M9 6l2 2-2 2" /></svg>
    </button>
  </div>
  <div
    bind:this={viewport}
    class="timeline-viewport"
    data-testid="timeline-viewport"
    aria-disabled={disabled}
    inert={disabled}
    on:wheel={wheel}
    on:scroll={noteScroll}
  >
    <div class="timeline-scroll-surface" data-testid="timeline-scroll-surface" style:width={`${scrollSurfaceWidth}px`}>
      <div bind:this={content} class="timeline-content" data-testid="timeline-content" style:width={`${contentWidth}px`}>
        <TimeRuler {durationMs} {pixelsPerSecond} {contentWidth} onscrubstart={(event) => beginScrub(event, true)} />
        <LoopSelectionBar {selection} {durationMs} {pixelsPerSecond} {contentWidth} {onchange} />
        <div aria-label="Waveform" class="waveform-slot" data-timeline-layer="waveform" style:width={`${contentWidth}px`}>
          {#if peaks}
            <WaveformView {peaks} {annotations} {activeAnnotationId} {previewAnnotationId}
              {selection} {playheadMs} {pixelsPerSecond}
              {onchange} {oncreate} {onseek}
              {onannotationpreview}
              {onannotationactivate}
            />
          {/if}
          <div
            class="playhead-grip"
            data-testid="timeline-playhead-grip"
            role="presentation"
            title="Drag to move the playhead"
            style:transform={`translateX(${playheadX}px)`}
            on:pointerdown={(event) => beginScrub(event, false)}
          ></div>
        </div>
        <div class="playhead" data-testid="timeline-playhead" aria-hidden="true" style:transform={`translateX(${playheadX}px)`}></div>
      </div>
    </div>
  </div>
</section>

<style>
  .timeline-workspace {
    position: relative;
    isolation: isolate;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-primary);
    background: var(--color-canvas);
  }

  .timeline-viewport {
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--color-canvas);
    scrollbar-color: var(--color-scrollbar-thumb) var(--color-scrollbar-track);
    scrollbar-width: thin;
  }

  .timeline-scroll-surface {
    min-width: 100%;
  }

  .timeline-content {
    position: relative;
    min-width: 0;
  }

  .waveform-slot {
    position: relative;
    isolation: isolate;
    height: clamp(96px, 16vh, 180px);
    overflow: hidden;
    background: var(--color-canvas);
  }

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -1px;
    z-index: 3;
    width: 2px;
    background: var(--color-playhead);
    pointer-events: none;
  }

  .playhead::before {
    position: absolute;
    top: 0;
    left: -4px;
    border-top: 6px solid var(--color-playhead);
    border-right: 5px solid transparent;
    border-left: 5px solid transparent;
    content: '';
  }

  .playhead-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -6px;
    z-index: 10;
    width: 12px;
    cursor: ew-resize;
    touch-action: none;
  }

  .zoom-controls {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 5;
    display: flex;
    gap: 1px;
    height: 19px;
    padding: 0 2px;
    background: var(--color-canvas);
    border-left: 1px solid var(--color-border);
  }

  .zoom-controls button {
    display: grid;
    place-items: center;
    width: 22px;
    min-width: 0;
    height: 19px;
    min-height: 0;
    padding: 0;
    color: var(--color-text-secondary);
    background: transparent;
    border: 0;
    border-radius: 3px;
  }

  .zoom-controls button:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-raised);
  }

  .zoom-controls button:disabled {
    color: var(--color-disabled-text);
    background: transparent;
  }

  .zoom-controls button:focus-visible {
    outline-offset: -2px;
  }

  .zoom-controls svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }
</style>
