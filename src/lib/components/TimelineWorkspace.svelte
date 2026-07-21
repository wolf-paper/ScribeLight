<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { PeakData } from '../bridge/native';
  import type { Selection, TimeDisplayFormat } from '../domain/types';
  import type { WaveformAnnotation } from '../waveform/wavesurferAdapter';
  import { timelineContentWidth, zoomAtPointer } from '../domain/timeline';
  import LoopSelectionBar from './LoopSelectionBar.svelte';
  import TimeRuler from './TimeRuler.svelte';
  import WaveformView from './WaveformView.svelte';

  export let durationMs: number;
  export let format: TimeDisplayFormat;
  export let selection: Selection | null;
  export let onchange: (selection: Selection) => void;
  export let peaks: PeakData | null = null;
  export let playheadMs = 0;
  export let annotations: readonly WaveformAnnotation[] = [];
  export let previewAnnotationId: string | null = null;
  export let disabled = false;

  let viewport: HTMLDivElement;
  let pixelsPerSecond = 100;
  let viewportWidth = 0;
  let pendingScrollLeft: number | null = null;
  let scrollGeneration = 0;

  $: contentWidth = timelineContentWidth(durationMs, pixelsPerSecond);
  $: scrollSurfaceWidth = Math.max(viewportWidth, contentWidth);

  function scheduleScrollAfterRender(target: number): void {
    pendingScrollLeft = target;
    const generation = ++scrollGeneration;
    void applyScrollAfterRender(generation, target);
  }

  function measureViewport(): void {
    viewportWidth = viewport && Number.isFinite(viewport.clientWidth) ? Math.max(0, viewport.clientWidth) : 0;
    if (!viewport) return;
    const currentScrollLeft = pendingScrollLeft ?? viewport.scrollLeft;
    const next = zoomAtPointer(
      { pixelsPerSecond, scrollLeft: currentScrollLeft, viewportWidth },
      0,
      0,
      durationMs
    );
    pixelsPerSecond = next.pixelsPerSecond;
    if (next.scrollLeft !== currentScrollLeft) scheduleScrollAfterRender(next.scrollLeft);
  }

  async function applyScrollAfterRender(generation: number, target: number): Promise<void> {
    await tick();
    if (generation !== scrollGeneration || !viewport || pendingScrollLeft !== target) return;
    viewport.scrollLeft = target;
    pendingScrollLeft = null;
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

  function wheel(event: WheelEvent): void {
    if (disabled || !event.ctrlKey || !viewport) return;
    event.preventDefault();
    measureViewport();
    const bounds = viewport.getBoundingClientRect();
    const next = zoomAtPointer(
      {
        pixelsPerSecond,
        scrollLeft: pendingScrollLeft ?? viewport.scrollLeft,
        viewportWidth
      },
      event.deltaY,
      event.clientX - bounds.left,
      durationMs
    );
    pixelsPerSecond = next.pixelsPerSecond;
    scheduleScrollAfterRender(next.scrollLeft);
  }
</script>

<section class="timeline-workspace" data-testid="timeline-workspace" aria-labelledby="timeline-title">
  <header class="timeline-header">
    <h2 id="timeline-title">Timeline</h2>
    <p>Ctrl + wheel to zoom</p>
  </header>
  <div bind:this={viewport} class="timeline-viewport" data-testid="timeline-viewport" aria-disabled={disabled} inert={disabled} on:wheel={wheel}>
    <div class="timeline-scroll-surface" data-testid="timeline-scroll-surface" style:width={`${scrollSurfaceWidth}px`}>
      <div class="timeline-content" data-testid="timeline-content" style:width={`${contentWidth}px`}>
        <TimeRuler {durationMs} {pixelsPerSecond} {format} {contentWidth} layer="top-ruler" />
        <LoopSelectionBar {selection} {durationMs} {pixelsPerSecond} {contentWidth} {onchange} />
        <div aria-label="Waveform" class="waveform-slot" data-timeline-layer="waveform" style:width={`${contentWidth}px`}>
          {#if peaks}
            <WaveformView {peaks} {annotations} {previewAnnotationId} {selection} {playheadMs} {pixelsPerSecond} {onchange} />
          {/if}
        </div>
        <TimeRuler {durationMs} {pixelsPerSecond} {format} {contentWidth} layer="bottom-ruler" />
      </div>
    </div>
  </div>
</section>

<style>
  .timeline-viewport {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-workspace {
    min-width: 0;
  }

  .timeline-content {
    min-width: 0;
    position: relative;
  }

  .waveform-slot {
    min-height: 80px;
  }
</style>
