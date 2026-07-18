<script lang="ts">
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

  $: contentWidth = timelineContentWidth(durationMs, pixelsPerSecond);

  function wheel(event: WheelEvent): void {
    if (!event.ctrlKey || !viewport) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    const next = zoomAtPointer(
      {
        pixelsPerSecond,
        scrollLeft: viewport.scrollLeft,
        viewportWidth: viewport.clientWidth
      },
      event.deltaY,
      event.clientX - bounds.left,
      durationMs
    );
    pixelsPerSecond = next.pixelsPerSecond;
    viewport.scrollLeft = next.scrollLeft;
  }
</script>

<div bind:this={viewport} class="timeline-viewport" data-testid="timeline-viewport" on:wheel={wheel}>
  <div class="timeline-content" data-testid="timeline-content" style:width={`${contentWidth}px`}>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} layer="top-ruler" />
    <LoopSelectionBar {selection} {durationMs} {pixelsPerSecond} {onchange} />
    <div aria-label="Waveform" class="waveform-slot" data-timeline-layer="waveform"><slot name="waveform" /></div>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} layer="bottom-ruler" />
  </div>
</div>

<style>
  .timeline-viewport {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-content {
    min-width: 100%;
    position: relative;
  }

  .waveform-slot {
    min-height: 80px;
  }
</style>
