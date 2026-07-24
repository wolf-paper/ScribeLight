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
  export let previewAnnotationId: string | null = null;
  export let onchange: (selection: Selection) => void;
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
  $: if (mounted && adapter) {
    adapter.setAnnotations(annotations);
    adapter.setPreviewAnnotation(previewAnnotationId);
    adapter.setSelection(selection);
    adapter.setPlayhead(playheadMs);
    adapter.setZoom(pixelsPerSecond);
  }
</script>

<div bind:this={container} class="waveform" role="img" aria-label="Audio waveform"></div>

<style>
  .waveform {
    min-height: 80px;
  }

  :global(.waveform ::part(regions-container)) {
    z-index: 4 !important;
  }
</style>
