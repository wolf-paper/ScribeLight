<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PeakData } from '../bridge/native';
  import type { Selection } from '../domain/types';
  import {
    createWaveformAdapter,
    type WaveformAdapter,
    type WaveformAdapterFactory,
    type WaveformAnnotation
  } from '../waveform/wavesurferAdapter';

  export let peaks: PeakData;
  export let selection: Selection | null;
  export let playheadMs = 0;
  export let pixelsPerSecond = 100;
  export let annotations: readonly WaveformAnnotation[] = [];
  export let activeAnnotationId: string | null = null;
  export let previewAnnotationId: string | null = null;
  export let onchange: (selection: Selection) => void;
  export let oncreate: (selection: Selection) => void;
  export let onseek: (milliseconds: number) => void;
  export let onannotationpreview: (annotationId: string, previewing: boolean) => void;
  export let onannotationactivate: (annotationId: string) => void;
  export let createAdapter: WaveformAdapterFactory = createWaveformAdapter;

  let container: HTMLDivElement;
  let adapter: WaveformAdapter | null = null;
  let activePeaks: PeakData | null = null;
  let mounted = false;

  function replaceAdapter(nextPeaks: PeakData): void {
    adapter?.destroy();
    adapter = createAdapter(container, nextPeaks, {
      onSelectionChange: onchange,
      onSelectionCreate: oncreate,
      onSeek: onseek,
      onAnnotationPreview: onannotationpreview,
      onAnnotationActivate: onannotationactivate
    });
    activePeaks = nextPeaks;
  }

  onMount(() => {
    mounted = true;
    replaceAdapter(peaks);
  });

  onDestroy(() => {
    mounted = false;
    adapter?.destroy();
    adapter = null;
  });

  $: if (mounted && peaks !== activePeaks) replaceAdapter(peaks);
  // One statement per setter so a playhead tick does not re-sync every region.
  $: if (adapter) adapter.setAnnotations(annotations);
  $: if (adapter) adapter.setActiveAnnotation(activeAnnotationId);
  $: if (adapter) adapter.setPreviewAnnotation(previewAnnotationId);
  $: if (adapter) adapter.setSelection(selection);
  $: if (adapter) adapter.setPlayhead(playheadMs);
  $: if (adapter) adapter.setZoom(pixelsPerSecond);
</script>

<div bind:this={container} class="waveform" role="img" aria-label="Audio waveform"></div>

<style>
  .waveform {
    height: 100%;
    min-height: 0;
    cursor: text;
    background: var(--color-canvas);
  }

  /* Parts below live in WaveSurfer's shadow root; only ::part() reaches them. */
  :global(.waveform ::part(region-handle-left)) {
    border-left-color: var(--color-loop-boundary) !important;
  }

  :global(.waveform ::part(region-handle-right)) {
    border-right-color: var(--color-loop-boundary) !important;
  }

  :global(.waveform ::part(scribelight-annotation)) {
    box-shadow: inset 1px 0 color-mix(in srgb, var(--color-accent) 40%, transparent);
  }

  :global(.waveform ::part(scribelight-annotation-active)) {
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    box-shadow: inset 0 0 0 1px var(--color-accent), inset 0 2px var(--color-accent);
  }

  :global(.waveform ::part(scribelight-annotation-label)),
  :global(.waveform ::part(scribelight-annotation-label-active)) {
    box-sizing: border-box;
    border-radius: 2px;
    background: color-mix(in srgb, var(--color-canvas) 70%, transparent);
    max-width: 100%;
    padding: 1px 4px;
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: 11px;
    line-height: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.waveform ::part(scribelight-annotation-label-active)) {
    margin-top: 2px;
    color: var(--color-text-primary);
    font-weight: 600;
  }
</style>
