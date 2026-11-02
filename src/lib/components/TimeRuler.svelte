<script lang="ts">
  import { rulerTicks, timelineContentWidth } from '../domain/timeline';

  export let durationMs: number;
  export let pixelsPerSecond: number;
  export let contentWidth: number;
  /** Press on the ruler: the parent seeks there and scrubs while the pointer drags. */
  export let onscrubstart: (event: PointerEvent) => void;

  $: ticks = rulerTicks(durationMs, pixelsPerSecond);
  $: width = Number.isFinite(contentWidth) ? Math.max(0, contentWidth) : 0;
</script>

<div
  class="time-ruler"
  data-timeline-layer="ruler"
  role="presentation"
  title="Click or drag to move the playhead"
  style:width={`${width}px`}
  on:pointerdown={onscrubstart}
>
  {#each ticks as tick (tick.ms)}
    <span class="tick" style:left={`${timelineContentWidth(tick.ms, pixelsPerSecond)}px`}>{tick.label}</span>
  {/each}
</div>

<style>
  .time-ruler {
    position: relative;
    box-sizing: border-box;
    height: 20px;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-secondary);
    background: var(--color-canvas);
    border-bottom: 1px solid var(--color-border);
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
  }

  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    padding: 0 0 0 4px;
    border-left: 1px solid var(--color-border);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 19px;
    white-space: nowrap;
    pointer-events: none;
  }
</style>
