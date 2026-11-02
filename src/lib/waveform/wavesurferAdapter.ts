import WaveSurfer, { type WaveSurferOptions } from 'wavesurfer.js';
import Regions, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type { PeakData } from '../bridge/native';
import type { Selection } from '../domain/types';

export interface WaveformAnnotation {
  id: string;
  startMs: number;
  endMs: number;
  /** Short text drawn at the region's top-left (the speaker label); may be empty. */
  label: string;
}

export interface WaveformAdapter {
  setSelection(selection: Selection | null): void;
  setAnnotations(annotations: readonly WaveformAnnotation[]): void;
  setActiveAnnotation(annotationId: string | null): void;
  setPreviewAnnotation(annotationId: string | null): void;
  setPlayhead(milliseconds: number): void;
  setZoom(pixelsPerSecond: number): void;
  destroy(): void;
}

export interface WaveformInteractionHandlers {
  /** The user resized or moved the current selection region. */
  onSelectionChange(selection: Selection): void;
  /** The user dragged out a new range anywhere, including on top of saved annotations. */
  onSelectionCreate(selection: Selection): void;
  /** The user clicked without dragging on the waveform background or the current selection. */
  onSeek(milliseconds: number): void;
  onAnnotationPreview(annotationId: string, previewing: boolean): void;
  /** The user clicked without dragging on a saved annotation outside the current selection. */
  onAnnotationActivate(annotationId: string): void;
}

export type WaveformFactory = (options: WaveSurferOptions) => WaveSurfer;
export type WaveformAdapterFactory = (
  container: HTMLElement,
  peaks: PeakData,
  handlers: WaveformInteractionHandlers
) => WaveformAdapter;

interface AnnotationRegion {
  region: Region;
  startMs: number;
  endMs: number;
  frame: HTMLElement;
  label: HTMLElement;
}

const canonicalRegionId = 'scribelight-canonical-selection';
const annotationRegionId = (id: string): string => `scribelight-annotation-${encodeURIComponent(id)}`;
const previewRegionId = 'scribelight-annotation-preview';
const passiveLayer = '1';
const activeLayer = '2';
const selectionLayer = '3';
const previewLayer = '4';
/** Labels are drawn only on regions at least this wide. */
const labelMinWidthPx = 40;
const labelLaneHeightPx = 14;
const labelLanes = 3;

interface WaveformPalette {
  wave: string;
  progress: string;
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

/**
 * Wires WaveSurfer as a pure renderer plus the regions plugin's drag selection.
 *
 * Gestures: a drag anywhere creates a new range (saved annotation regions ignore pointer events
 * so a drag can start on top of them); dragging the current selection's body or edges adjusts
 * it; a click without drag activates the saved annotation under the pointer, or seeks when there
 * is none or the click lands on the current selection. Hover is hit-tested the same way.
 */
export function createWaveformAdapter(
  container: HTMLElement,
  peaks: PeakData,
  handlers: WaveformInteractionHandlers,
  factory: WaveformFactory = WaveSurfer.create
): WaveformAdapter {
  const initialPalette = resolvePalette(container);
  const wave = factory({
    container,
    peaks: peaks.channels,
    duration: peaks.durationMs / 1_000,
    interact: false,
    dragToSeek: false,
    height: 'auto',
    waveColor: initialPalette.wave,
    progressColor: initialPalette.progress,
    cursorWidth: 0,
    normalize: true,
    fillParent: true,
    minPxPerSec: 0
  });
  const regions = wave.registerPlugin(Regions.create());
  const wrapper = wave.getWrapper();
  let region: Region | null = null;
  let desiredSelection: Selection | null = null;
  let desiredAnnotations: readonly WaveformAnnotation[] = [];
  let desiredActiveAnnotationId: string | null = null;
  let desiredPreviewAnnotationId: string | null = null;
  const annotationRegions = new Map<string, AnnotationRegion>();
  let previewRegion: Region | null = null;
  let previewAnnotationId: string | null = null;
  let hoveredAnnotationId: string | null = null;
  let desiredPlayheadMs = 0;
  let desiredZoom: number | null = null;
  let appliedZoom: number | null = null;
  let renderedHeight = 0;
  let ready = false;
  let syncing = false;
  let destroyed = false;
  const regionOptions = {
    color: initialPalette.selection,
    drag: true,
    resize: true
  };
  const stopDrag = regions.enableDragSelection(regionOptions);

  const markSelection = (next: Region): void => {
    const element = next.element;
    if (!element) return;
    element.dataset.scribelightRegion = 'selection';
    element.style.zIndex = selectionLayer;
  };

  const createAnnotationRegion = (annotation: WaveformAnnotation, color: string): AnnotationRegion => {
    const next = regions.addRegion({
      id: annotationRegionId(annotation.id),
      start: annotation.startMs / 1_000,
      end: annotation.endMs / 1_000,
      color,
      drag: false,
      resize: false
    });
    const document = container.ownerDocument;
    const frame = document.createElement('div');
    frame.setAttribute('part', 'scribelight-annotation');
    Object.assign(frame.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    const label = document.createElement('span');
    label.setAttribute('part', 'scribelight-annotation-label');
    Object.assign(label.style, { position: 'absolute', left: '0', pointerEvents: 'none' });
    frame.append(label);
    const element = next.element;
    if (element) {
      element.dataset.scribelightRegion = 'annotation';
      element.dataset.annotationId = annotation.id;
      // Pointer events pass through to the wrapper so drags starting here create a new range;
      // hover and click are hit-tested against the annotation times instead.
      element.style.pointerEvents = 'none';
      element.style.zIndex = passiveLayer;
      element.append(frame);
    }
    return { region: next, startMs: annotation.startMs, endMs: annotation.endMs, frame, label };
  };

  const markPreview = (next: Region, annotationId: string): void => {
    const element = next.element;
    if (!element) return;
    element.dataset.scribelightRegion = 'preview';
    element.dataset.annotationId = annotationId;
    element.style.pointerEvents = 'none';
    element.style.zIndex = previewLayer;
  };

  const isManagedRegion = (next: Region): boolean => {
    if (next === previewRegion) return true;
    for (const annotationRegion of annotationRegions.values()) {
      if (next === annotationRegion.region) return true;
    }
    return false;
  };

  const applyPalette = (): void => {
    if (destroyed) return;
    const palette = resolvePalette(container);
    regionOptions.color = palette.selection;
    wave.setOptions({
      waveColor: palette.wave,
      progressColor: palette.progress
    });
    syncing = true;
    try {
      region?.setOptions({ color: palette.selection });
      for (const annotationRegion of annotationRegions.values()) {
        annotationRegion.region.setOptions({ color: palette.annotation });
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

  /** Active emphasis, label text, visibility (wide enough at this zoom) and overlap lanes. */
  const applyAnnotationDecorations = (): void => {
    if (!ready || destroyed) return;
    const pixelsPerSecond = desiredZoom ?? 0;
    const laneEnds: number[] = [];
    const ordered = [...desiredAnnotations].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (const annotation of ordered) {
      const decorated = annotationRegions.get(annotation.id);
      if (!decorated) continue;
      const active = annotation.id === desiredActiveAnnotationId;
      decorated.frame.setAttribute('part', active ? 'scribelight-annotation-active' : 'scribelight-annotation');
      decorated.label.setAttribute(
        'part',
        active ? 'scribelight-annotation-label-active' : 'scribelight-annotation-label'
      );
      decorated.label.textContent = annotation.label;
      const element = decorated.region.element;
      if (element) {
        element.style.zIndex = active ? activeLayer : passiveLayer;
        if (active) element.dataset.active = 'true';
        else delete element.dataset.active;
      }

      const widthPx = (annotation.endMs - annotation.startMs) / 1_000 * pixelsPerSecond;
      const wantsLabel = annotation.label !== '' && widthPx >= labelMinWidthPx;
      let lane = wantsLabel ? laneEnds.findIndex((end) => end <= annotation.startMs) : -1;
      if (wantsLabel && lane < 0 && laneEnds.length < labelLanes) lane = laneEnds.length;
      if (lane >= 0) laneEnds[lane] = annotation.endMs;
      decorated.label.style.display = lane >= 0 ? '' : 'none';
      decorated.label.style.top = `${Math.max(0, lane) * labelLaneHeightPx}px`;
    }
  };

  const setHoveredAnnotation = (annotationId: string | null): void => {
    if (annotationId === hoveredAnnotationId) return;
    const previous = hoveredAnnotationId;
    hoveredAnnotationId = annotationId;
    container.style.cursor = annotationId ? 'pointer' : '';
    if (destroyed) return;
    if (previous) handlers.onAnnotationPreview(previous, false);
    if (annotationId) handlers.onAnnotationPreview(annotationId, true);
  };

  const applyAnnotations = (): void => {
    if (!ready || destroyed) return;
    const desiredById = new Map(desiredAnnotations.map((annotation) => [annotation.id, annotation]));
    let palette: WaveformPalette | null = null;
    syncing = true;
    try {
      for (const [id, annotationRegion] of annotationRegions) {
        if (desiredById.has(id)) continue;
        annotationRegion.region.remove();
        annotationRegions.delete(id);
      }

      for (const annotation of desiredById.values()) {
        const existing = annotationRegions.get(annotation.id);
        if (!existing) {
          palette ??= resolvePalette(container);
          annotationRegions.set(annotation.id, createAnnotationRegion(annotation, palette.annotation));
        } else if (existing.startMs !== annotation.startMs || existing.endMs !== annotation.endMs) {
          existing.region.setOptions({
            start: annotation.startMs / 1_000,
            end: annotation.endMs / 1_000
          });
          existing.startMs = annotation.startMs;
          existing.endMs = annotation.endMs;
        }
      }
    } finally {
      syncing = false;
    }
    applyAnnotationDecorations();
    if (hoveredAnnotationId && !desiredById.has(hoveredAnnotationId)) setHoveredAnnotation(null);
  };

  const applyPreview = (): void => {
    if (!ready || destroyed) return;
    const annotation = desiredAnnotations.find(({ id }) => id === desiredPreviewAnnotationId);
    syncing = true;
    try {
      if (!annotation) {
        previewRegion?.remove();
        previewRegion = null;
        previewAnnotationId = null;
        return;
      }

      const palette = resolvePalette(container);
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
    if (!ready || destroyed || desiredZoom === null || desiredZoom === appliedZoom) return;
    appliedZoom = desiredZoom;
    wave.setOptions({ fillParent: true, minPxPerSec: 0 });
    applyAnnotationDecorations();
  };

  // WaveSurfer only re-measures its 'auto' height on width changes; redraw on height changes too.
  const heightObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
      const height = container.clientHeight;
      if (!ready || destroyed || height <= 0 || height === renderedHeight) return;
      renderedHeight = height;
      wave.setOptions({ height: 'auto' });
    });
  heightObserver?.observe(container);

  const timeAtClientX = (clientX: number): number | null => {
    const bounds = wrapper.getBoundingClientRect();
    const duration = Math.max(0, Math.round(peaks.durationMs));
    if (!(bounds.width > 0) || duration === 0 || !Number.isFinite(clientX)) return null;
    return Math.round(clamp((clientX - bounds.left) / bounds.width, 1) * duration);
  };

  const isOnSelection = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-scribelight-region="selection"]') !== null;

  /** The innermost (shortest) saved annotation containing `milliseconds`; later wins ties. */
  const annotationAt = (milliseconds: number): string | null => {
    let found: WaveformAnnotation | null = null;
    for (const annotation of desiredAnnotations) {
      if (milliseconds < annotation.startMs || milliseconds > annotation.endMs) continue;
      if (!found || annotation.endMs - annotation.startMs <= found.endMs - found.startMs) found = annotation;
    }
    return found?.id ?? null;
  };

  const pointerMoved = (event: PointerEvent): void => {
    if (!ready || destroyed) return;
    if (event.buttons !== 0 || isOnSelection(event.target)) {
      setHoveredAnnotation(null);
      return;
    }
    const milliseconds = timeAtClientX(event.clientX);
    setHoveredAnnotation(milliseconds === null ? null : annotationAt(milliseconds));
  };
  const pointerLeft = (): void => setHoveredAnnotation(null);
  // The regions plugin swallows the click that ends a drag, so this only sees plain clicks.
  const clicked = (event: MouseEvent): void => {
    if (!ready || destroyed || event.button !== 0) return;
    const milliseconds = timeAtClientX(event.clientX);
    if (milliseconds === null) return;
    const annotationId = isOnSelection(event.target) ? null : annotationAt(milliseconds);
    if (annotationId) handlers.onAnnotationActivate(annotationId);
    else handlers.onSeek(milliseconds);
  };
  // The plugin draws a drag-created region 5 px past the pointer; track the press and the pointer
  // ourselves so a new range spans exactly what was dragged.
  let dragPress: { pointerId: number; anchorMs: number; pointerMs: number } | null = null;
  const pressed = (event: PointerEvent): void => {
    const milliseconds = event.button === 0 && !isOnSelection(event.target) ? timeAtClientX(event.clientX) : null;
    dragPress = milliseconds === null
      ? null
      : { pointerId: event.pointerId, anchorMs: milliseconds, pointerMs: milliseconds };
  };
  const trackDrag = (event: PointerEvent): void => {
    if (!dragPress || event.pointerId !== dragPress.pointerId) return;
    dragPress.pointerMs = timeAtClientX(event.clientX) ?? dragPress.pointerMs;
  };
  const ownerWindow = container.ownerDocument.defaultView ?? window;
  wrapper.addEventListener('pointermove', pointerMoved);
  wrapper.addEventListener('pointerleave', pointerLeft);
  wrapper.addEventListener('click', clicked);
  wrapper.addEventListener('pointerdown', pressed);
  // Window capture runs before the plugin's document listeners, which finish the drag on release.
  ownerWindow.addEventListener('pointermove', trackDrag, true);
  ownerWindow.addEventListener('pointerup', trackDrag, true);

  const reportUserSelection = (next: Region | null): void => {
    if (destroyed || syncing || !next || next !== region) return;
    handlers.onSelectionChange(normalizeRegion(next.start, next.end, peaks.durationMs));
  };
  const adoptCanonical = (next: Region): void => {
    if (!desiredSelection || (region && region !== next)) next.remove();
    else {
      region = next;
      markSelection(next);
    }
  };
  const stopInitialized = regions.on('region-initialized', (next) => {
    if (destroyed || syncing || isManagedRegion(next)) return;
    if (next.id === canonicalRegionId) {
      adoptCanonical(next);
      return;
    }
    // A drag selection just started: it replaces the current selection region.
    if (region && region !== next) region.remove();
    region = next;
    markSelection(next);
  });
  const stopCreated = regions.on('region-created', (next) => {
    if (destroyed || syncing || isManagedRegion(next)) return;
    if (next.id === canonicalRegionId) {
      adoptCanonical(next);
      return;
    }
    if (region && region !== next) region.remove();
    region = next;
    markSelection(next);
    const created = dragPress
      ? normalizeRegion(
        Math.min(dragPress.anchorMs, dragPress.pointerMs) / 1_000,
        Math.max(dragPress.anchorMs, dragPress.pointerMs) / 1_000,
        peaks.durationMs
      )
      : normalizeRegion(next.start, next.end, peaks.durationMs);
    dragPress = null;
    syncing = true;
    try {
      next.setOptions({ start: created.startMs / 1_000, end: created.endMs / 1_000 });
    } finally {
      syncing = false;
    }
    handlers.onSelectionCreate(created);
  });
  const stopUpdated = regions.on('region-updated', reportUserSelection);
  const stopReady = wave.on('ready', () => {
    if (destroyed) return;
    ready = true;
    renderedHeight = container.clientHeight;
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
      const unchanged = annotations.length === desiredAnnotations.length
        && annotations.every((next, index) => {
          const current = desiredAnnotations[index];
          return next.id === current.id && next.startMs === current.startMs
            && next.endMs === current.endMs && next.label === current.label;
        });
      // Callers re-send equal lists on unrelated updates (e.g. every playhead tick).
      if (destroyed || unchanged) return;
      desiredAnnotations = [...annotations];
      applyAnnotations();
      applyPreview();
    },
    setActiveAnnotation(annotationId) {
      if (destroyed || annotationId === desiredActiveAnnotationId) return;
      desiredActiveAnnotationId = annotationId;
      applyAnnotationDecorations();
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
      wrapper.removeEventListener('pointermove', pointerMoved);
      wrapper.removeEventListener('pointerleave', pointerLeft);
      wrapper.removeEventListener('click', clicked);
      wrapper.removeEventListener('pointerdown', pressed);
      ownerWindow.removeEventListener('pointermove', trackDrag, true);
      ownerWindow.removeEventListener('pointerup', trackDrag, true);
      dragPress = null;
      container.style.cursor = '';
      syncing = true;
      try {
        region?.remove();
        for (const annotationRegion of annotationRegions.values()) annotationRegion.region.remove();
        previewRegion?.remove();
      } finally {
        syncing = false;
      }
      region = null;
      annotationRegions.clear();
      previewRegion = null;
      previewAnnotationId = null;
      hoveredAnnotationId = null;
      stopDrag();
      stopInitialized();
      stopCreated();
      stopUpdated();
      stopReady();
      heightObserver?.disconnect();
      paletteObserver?.disconnect();
      wave.destroy();
    }
  };
}
