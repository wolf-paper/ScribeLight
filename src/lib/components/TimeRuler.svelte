<script lang="ts">
  import { formatTime } from '../domain/time';
  import { rulerTicks, timelineContentWidth } from '../domain/timeline';
  import type { TimeDisplayFormat } from '../domain/types';

  export let durationMs: number;
  export let pixelsPerSecond: number;
  export let format: TimeDisplayFormat;
  export let layer: 'top-ruler' | 'bottom-ruler';
  export let contentWidth: number;

  $: ticks = rulerTicks(durationMs, pixelsPerSecond);
  $: width = Number.isFinite(contentWidth) ? Math.max(0, contentWidth) : 0;
</script>

<div class="time-ruler" aria-label="Time ruler" data-timeline-layer={layer} style:width={`${width}px`}>
  {#each ticks as tick (tick)}
    <span class="tick" style:left={`${timelineContentWidth(tick, pixelsPerSecond)}px`}>{formatTime(tick, format)}</span>
  {/each}
</div>

<style>
  .time-ruler {
    box-sizing: border-box;
    height: 26px;
    min-width: 0;
    position: relative;
  }

  .tick {
    border-left: 1px solid currentColor;
    font-size: 0.75rem;
    opacity: 0.8;
    padding-left: 3px;
    position: absolute;
    transform: translateX(-1px);
    white-space: nowrap;
  }
</style>
