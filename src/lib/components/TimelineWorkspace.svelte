<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Selection, TimeDisplayFormat } from '../domain/types';
  import { timelineContentWidth, zoomAtPointer } from '../domain/timeline';
  import LoopSelectionBar from './LoopSelectionBar.svelte';
  import TimeRuler from './TimeRuler.svelte';

  export let durationMs: number;
  export let format: TimeDisplayFormat;
  export let selection: Selection | null;
  export let onchange: (selection: Selection) => void;

  let viewport: HTMLDivElement;
  let pixelsPerSecond = 100;
  let viewportWidth = 0;
  let pendingScrollLeft: number | null = null;
  let scrollGeneration = 0;

  $: contentWidth = Math.max(viewportWidth, timelineContentWidth(durationMs, pixelsPerSecond));

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
    if (!event.ctrlKey || !viewport) return;
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

<div bind:this={viewport} class="timeline-viewport" data-testid="timeline-viewport" on:wheel={wheel}>
  <div class="timeline-content" data-testid="timeline-content" style:width={`${contentWidth}px`}>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} {contentWidth} layer="top-ruler" />
    <LoopSelectionBar {selection} {durationMs} {pixelsPerSecond} {contentWidth} {onchange} />
    <div aria-label="Waveform" class="waveform-slot" data-timeline-layer="waveform" style:width={`${contentWidth}px`}><slot name="waveform" /></div>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} {contentWidth} layer="bottom-ruler" />
  </div>
</div>

<style>
  .timeline-viewport {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-content {
    position: relative;
  }

  .waveform-slot {
    min-height: 80px;
  }
</style>
