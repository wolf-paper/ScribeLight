<script lang="ts">
  import type { Selection } from '../domain/types';

  type DragKind = 'start' | 'body' | 'end';
  interface DragState {
    kind: DragKind;
    pointerId: number;
    startClientX: number;
    initial: Selection;
  }

  export let selection: Selection | null;
  export let durationMs: number;
  export let pixelsPerSecond: number;
  export let contentWidth: number;
  export let onchange: (selection: Selection) => void;

  let drag: DragState | null = null;

  function clipDuration(): number {
    return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  }

  function safeMilliseconds(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.round(value) : fallback;
  }

  function normalizedSelection(value: Selection | null): Selection | null {
    const duration = clipDuration();
    if (!value || duration < 1) return null;
    const start = Math.min(duration - 1, Math.max(0, safeMilliseconds(value.startMs, 0)));
    const end = Math.min(duration, Math.max(start + 1, safeMilliseconds(value.endMs, start + 1)));
    return { startMs: start, endMs: end };
  }

  function safePixelsPerSecond(value = pixelsPerSecond): number {
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function beginDrag(event: PointerEvent, kind: DragKind): void {
    const initial = normalizedSelection(selection);
    if (!initial) return;
    const target = event.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in some embedded/test environments; track handlers remain a safe fallback.
      }
    }
    drag = { kind, pointerId: event.pointerId, startClientX: event.clientX, initial };
  }

  function endDrag(event: PointerEvent): void {
    if (drag && (!event.pointerId || event.pointerId === drag.pointerId)) drag = null;
  }

  function move(event: PointerEvent): void {
    if (!drag || (event.pointerId && event.pointerId !== drag.pointerId)) return;
    const duration = clipDuration();
    if (duration < 1) return;

    const deltaMs = Math.round((event.clientX - drag.startClientX) * 1000 / safePixelsPerSecond());
    let next: Selection;
    if (drag.kind === 'start') {
      next = {
        startMs: Math.min(drag.initial.endMs - 1, Math.max(0, drag.initial.startMs + deltaMs)),
        endMs: drag.initial.endMs
      };
    } else if (drag.kind === 'end') {
      next = {
        startMs: drag.initial.startMs,
        endMs: Math.max(drag.initial.startMs + 1, Math.min(duration, drag.initial.endMs + deltaMs))
      };
    } else {
      const width = drag.initial.endMs - drag.initial.startMs;
      const startMs = Math.min(duration - width, Math.max(0, drag.initial.startMs + deltaMs));
      next = { startMs, endMs: startMs + width };
    }
    onchange(next);
  }

  $: visibleSelection = normalizedSelection(selection);
  $: trackWidth = Number.isFinite(contentWidth) ? Math.max(0, contentWidth) : 0;
  $: safePixels = safePixelsPerSecond(pixelsPerSecond);
  $: left = visibleSelection ? visibleSelection.startMs / 1000 * safePixels : 0;
  $: width = visibleSelection ? (visibleSelection.endMs - visibleSelection.startMs) / 1000 * safePixels : 0;
</script>

<div
  aria-label="Loop selection"
  class="selection-track"
  data-timeline-layer="loop-selection"
  style:width={`${trackWidth}px`}
  on:pointermove={move}
  on:pointerup={endDrag}
  on:pointercancel={endDrag}
  on:lostpointercapture={endDrag}
  role="group"
>
  {#if visibleSelection}
    <div class="selection" style:left={`${left}px`} style:width={`${width}px`}>
      <button aria-label="Resize loop start" class="handle" on:pointerdown={(event) => beginDrag(event, 'start')} type="button"></button>
      <button aria-label="Move loop selection" class="body" on:pointerdown={(event) => beginDrag(event, 'body')} type="button"></button>
      <button aria-label="Resize loop end" class="handle" on:pointerdown={(event) => beginDrag(event, 'end')} type="button"></button>
    </div>
  {/if}
</div>

<style>
  .selection-track {
    position: relative;
    height: 14px;
    min-width: 0;
    background: var(--color-canvas);
    touch-action: none;
  }

  .selection {
    position: absolute;
    top: 2px;
    bottom: 2px;
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) 8px;
    border-radius: 2px;
    background: var(--color-selection-wash);
    box-shadow: inset 0 1px var(--color-loop-boundary), inset 0 -1px var(--color-loop-boundary);
  }

  .selection button,
  .selection button:hover:not(:disabled) {
    min-width: 0;
    min-height: 0;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .selection .handle { cursor: col-resize; }
  .selection .handle:first-child { box-shadow: inset 2px 0 var(--color-loop-boundary); }
  .selection .handle:last-child { box-shadow: inset -2px 0 var(--color-loop-boundary); }
  .selection .body { cursor: grab; }
  .selection .body:active { cursor: grabbing; }
  .selection button:focus-visible { outline-offset: -2px; }
</style>
