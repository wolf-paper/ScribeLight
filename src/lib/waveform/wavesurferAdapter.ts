import WaveSurfer, { type WaveSurferOptions } from 'wavesurfer.js';
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type { PeakData } from '../bridge/native';
import type { Selection } from '../domain/types';

export interface WaveformAnnotation {
  id: string;
  startMs: number;
  endMs: number;
}

export interface WaveformAdapter {
  setSelection(selection: Selection | null): void;
  setAnnotations(annotations: readonly WaveformAnnotation[]): void;
  setPreviewAnnotation(annotationId: string | null): void;
  setPlayhead(milliseconds: number): void;
  setZoom(pixelsPerSecond: number): void;
  destroy(): void;
}

export type WaveformFactory = (options: WaveSurferOptions) => WaveSurfer;
export type WaveformAdapterFactory = (
  container: HTMLElement,
  peaks: PeakData,
  onchange: (selection: Selection) => void
) => WaveformAdapter;

const canonicalRegionId = 'lightscribe-canonical-selection';
const annotationRegionId = (id: string): string => `lightscribe-annotation-${encodeURIComponent(id)}`;
const previewRegionId = 'lightscribe-annotation-preview';
const passiveLayer = '1';
const selectionLayer = '2';
const previewLayer = '3';

interface WaveformPalette {
  wave: string;
  progress: string;
  cursor: string;
  selection: string;
  annotation: string;
  annotationPreview: string;
}

function resolvePalette(container: HTMLElement): WaveformPalette {
  const style = container.ownerDocument.defaultView?.getComputedStyle(container) ?? getComputedStyle(container);
  const token = (name: string): string => style.getPropertyValue(name).trim() || `var(${name})`;
  return {
    wave: token('--color-waveform'),
    progress: token('--color-waveform-active'),
    cursor: token('--color-playhead'),
    selection: token('--color-selection-region'),
    annotation: token('--color-annotation-region'),
    annotationPreview: token('--color-annotation-preview')
  };
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), maximum);
}

function normalizeRegion(startSeconds: number, endSeconds: number, durationMs: number): Selection {
  const duration = Math.max(0, Math.round(durationMs));
  let startMs = clamp(Math.round(startSeconds * 1_000), duration);
  let endMs = clamp(Math.round(endSeconds * 1_000), duration);

  if (duration > 0 && endMs <= startMs) {
    if (startMs >= duration) {
      startMs = duration - 1;
      endMs = duration;
    } else {
      endMs = Math.min(duration, startMs + 1);
    }
  }

  return { startMs, endMs };
}

export function createWaveformAdapter(
  container: HTMLElement,
  peaks: PeakData,
  onchange: (selection: Selection) => void,
  factory: WaveformFactory = WaveSurfer.create
): WaveformAdapter {
  const initialPalette = resolvePalette(container);
  const wave = factory({
    container,
    peaks: peaks.channels,
    duration: peaks.durationMs / 1_000,
    interact: false,
    dragToSeek: false,
    waveColor: initialPalette.wave,
    progressColor: initialPalette.progress,
    cursorColor: initialPalette.cursor,
    cursorWidth: 0,
    normalize: true,
    fillParent: false
  });
  const regions = wave.registerPlugin(Regions.create());
  let region: ReturnType<typeof regions.addRegion> | null = null;
  let desiredSelection: Selection | null = null;
  let desiredAnnotations: readonly WaveformAnnotation[] = [];
  let desiredPreviewAnnotationId: string | null = null;
  const annotationRegions = new Map<string, ReturnType<typeof regions.addRegion>>();
  let previewRegion: ReturnType<typeof regions.addRegion> | null = null;
  let previewAnnotationId: string | null = null;
  let desiredPlayheadMs = 0;
  let desiredZoom: number | null = null;
  let ready = false;
  let syncing = false;
  let destroyed = false;
  const regionOptions = {
    color: initialPalette.selection,
    drag: true,
    resize: true
  };
  const stopDrag = regions.enableDragSelection(regionOptions);

  const markSelection = (next: ReturnType<typeof regions.addRegion>): void => {
    next.element.dataset.lightscribeRegion = 'selection';
    next.element.style.zIndex = selectionLayer;
  };

  const markAnnotation = (
    next: ReturnType<typeof regions.addRegion>,
    annotationId: string
  ): void => {
    next.element.dataset.lightscribeRegion = 'annotation';
    next.element.dataset.annotationId = annotationId;
    next.element.style.pointerEvents = 'none';
    next.element.style.zIndex = passiveLayer;
  };

  const markPreview = (
    next: ReturnType<typeof regions.addRegion>,
    annotationId: string
  ): void => {
    next.element.dataset.lightscribeRegion = 'preview';
    next.element.dataset.annotationId = annotationId;
    next.element.style.pointerEvents = 'none';
    next.element.style.zIndex = previewLayer;
  };

  const isManagedRegion = (next: ReturnType<typeof regions.addRegion>): boolean => {
    if (next === previewRegion) return true;
    for (const annotationRegion of annotationRegions.values()) {
      if (next === annotationRegion) return true;
    }
    return false;
  };

  const applyPalette = (): void => {
    if (destroyed) return;
    const palette = resolvePalette(container);
    regionOptions.color = palette.selection;
    wave.setOptions({
      waveColor: palette.wave,
      progressColor: palette.progress,
      cursorColor: palette.cursor
    });
    syncing = true;
    try {
      region?.setOptions({ color: palette.selection });
      for (const annotationRegion of annotationRegions.values()) {
        annotationRegion.setOptions({ color: palette.annotation });
      }
      previewRegion?.setOptions({ color: palette.annotationPreview });
    } finally {
      syncing = false;
    }
  };
  const paletteObserver = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(applyPalette);
  paletteObserver?.observe(container.ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ['data-palette']
  });

  const applySelection = (): void => {
    if (!ready || destroyed) return;
    syncing = true;
    try {
      if (!desiredSelection) {
        region?.remove();
        region = null;
      } else if (region) {
        region.setOptions({
          start: desiredSelection.startMs / 1_000,
          end: desiredSelection.endMs / 1_000
        });
      } else {
        region = regions.addRegion({
          ...regionOptions,
          id: canonicalRegionId,
          start: desiredSelection.startMs / 1_000,
          end: desiredSelection.endMs / 1_000
        });
        markSelection(region);
      }
    } finally {
      syncing = false;
    }
  };

  const applyAnnotations = (): void => {
    if (!ready || destroyed) return;
    const desiredById = new Map(desiredAnnotations.map((annotation) => [annotation.id, annotation]));
    const palette = resolvePalette(container);
    syncing = true;
    try {
      for (const [id, annotationRegion] of annotationRegions) {
        if (desiredById.has(id)) continue;
        annotationRegion.remove();
        annotationRegions.delete(id);
      }

      for (const annotation of desiredById.values()) {
        const existing = annotationRegions.get(annotation.id);
        if (existing) {
          existing.setOptions({
            start: annotation.startMs / 1_000,
            end: annotation.endMs / 1_000,
            color: palette.annotation
          });
          continue;
        }

        const next = regions.addRegion({
          id: annotationRegionId(annotation.id),
          start: annotation.startMs / 1_000,
          end: annotation.endMs / 1_000,
          color: palette.annotation,
          drag: false,
          resize: false
        });
        annotationRegions.set(annotation.id, next);
        markAnnotation(next, annotation.id);
      }
    } finally {
      syncing = false;
    }
  };

  const applyPreview = (): void => {
    if (!ready || destroyed) return;
    const annotation = desiredAnnotations.find(({ id }) => id === desiredPreviewAnnotationId);
    const palette = resolvePalette(container);
    syncing = true;
    try {
      if (!annotation) {
        previewRegion?.remove();
        previewRegion = null;
        previewAnnotationId = null;
        return;
      }

      if (previewRegion && previewAnnotationId === annotation.id) {
        previewRegion.setOptions({
          start: annotation.startMs / 1_000,
          end: annotation.endMs / 1_000,
          color: palette.annotationPreview
        });
        return;
      }

      previewRegion?.remove();
      previewRegion = regions.addRegion({
        id: previewRegionId,
        start: annotation.startMs / 1_000,
        end: annotation.endMs / 1_000,
        color: palette.annotationPreview,
        drag: false,
        resize: false
      });
      previewAnnotationId = annotation.id;
      markPreview(previewRegion, annotation.id);
    } finally {
      syncing = false;
    }
  };

  const applyPlayhead = (): void => {
    if (!ready || destroyed) return;
    const duration = peaks.durationMs;
    const fraction = Number.isFinite(duration) && duration > 0
      ? clamp(desiredPlayheadMs / duration, 1)
      : 0;
    wave.getRenderer().renderProgress(fraction, false);
  };

  const applyZoom = (): void => {
    if (!ready || destroyed || desiredZoom === null) return;
    try {
      wave.zoom(desiredZoom);
    } catch {
      // WaveSurfer rejects zoom before its decoded peaks are available.
    }
  };

  const reportUserSelection = (next: typeof region): void => {
    if (destroyed || syncing || !next || next !== region) return;
    onchange(normalizeRegion(next.start, next.end, peaks.durationMs));
  };
  const stopInitialized = regions.on('region-initialized', (next) => {
    if (destroyed || syncing) return;
    if (isManagedRegion(next)) return;
    if (next.id === canonicalRegionId) {
      if (!desiredSelection || (region && region !== next)) next.remove();
      else {
        region = next;
        markSelection(next);
      }
      return;
    }
    if (region && region !== next) region.remove();
    region = next;
    markSelection(next);
  });
  const stopCreated = regions.on('region-created', (next) => {
    if (destroyed || syncing) return;
    if (isManagedRegion(next)) return;
    if (next.id === canonicalRegionId) {
      if (!desiredSelection || (region && region !== next)) next.remove();
      else {
        region = next;
        markSelection(next);
      }
      return;
    }
    if (region && region !== next) region.remove();
    region = next;
    markSelection(next);
    reportUserSelection(next);
  });
  const stopUpdated = regions.on('region-updated', reportUserSelection);
  const stopReady = wave.on('ready', () => {
    if (destroyed) return;
    ready = true;
    applyAnnotations();
    applySelection();
    applyPreview();
    applyPlayhead();
    applyZoom();
  });

  return {
    setSelection(selection) {
      if (destroyed) return;
      desiredSelection = selection;
      applySelection();
    },
    setAnnotations(annotations) {
      if (destroyed) return;
      desiredAnnotations = [...annotations];
      applyAnnotations();
      applyPreview();
    },
    setPreviewAnnotation(annotationId) {
      if (destroyed) return;
      desiredPreviewAnnotationId = annotationId;
      applyPreview();
    },
    setPlayhead(milliseconds) {
      if (destroyed) return;
      desiredPlayheadMs = Number.isFinite(milliseconds) ? milliseconds : 0;
      applyPlayhead();
    },
    setZoom(pixelsPerSecond) {
      if (destroyed || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return;
      desiredZoom = pixelsPerSecond;
      applyZoom();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      syncing = true;
      try {
        region?.remove();
        for (const annotationRegion of annotationRegions.values()) annotationRegion.remove();
        previewRegion?.remove();
      } finally {
        syncing = false;
      }
      region = null;
      annotationRegions.clear();
      previewRegion = null;
      previewAnnotationId = null;
      stopDrag();
      stopInitialized();
      stopCreated();
      stopUpdated();
      stopReady();
      paletteObserver?.disconnect();
      wave.destroy();
    }
  };
}
