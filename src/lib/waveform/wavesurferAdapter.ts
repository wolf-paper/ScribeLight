import WaveSurfer, { type WaveSurferOptions } from 'wavesurfer.js';
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type { PeakData } from '../bridge/native';
import type { Selection } from '../domain/types';

export interface WaveformAdapter {
  setSelection(selection: Selection | null): void;
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

const regionOptions = {
  color: 'rgba(104, 164, 255, .28)',
  drag: true,
  resize: true
};
const canonicalRegionId = 'lightscribe-canonical-selection';

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
  const wave = factory({
    container,
    peaks: peaks.channels,
    duration: peaks.durationMs / 1_000,
    interact: false,
    dragToSeek: false,
    waveColor: '#66758a',
    progressColor: '#8ba8d8',
    cursorWidth: 0,
    normalize: true
  });
  const regions = wave.registerPlugin(Regions.create());
  let region: ReturnType<typeof regions.addRegion> | null = null;
  let desiredSelection: Selection | null = null;
  let desiredPlayheadMs = 0;
  let desiredZoom: number | null = null;
  let ready = false;
  let syncing = false;
  let destroyed = false;
  const stopDrag = regions.enableDragSelection(regionOptions);

  const applySelection = (): void => {
    if (!ready || destroyed) return;
    syncing = true;
    try {
      if (!desiredSelection) {
        regions.clearRegions();
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
      }
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
  const stopCreated = regions.on('region-created', (next) => {
    if (destroyed || syncing) return;
    if (next.id === canonicalRegionId) {
      if (!desiredSelection || (region && region !== next)) next.remove();
      else region = next;
      return;
    }
    if (region && region !== next) region.remove();
    region = next;
    reportUserSelection(next);
  });
  const stopUpdated = regions.on('region-updated', reportUserSelection);
  const stopReady = wave.on('ready', () => {
    if (destroyed) return;
    ready = true;
    applySelection();
    applyPlayhead();
    applyZoom();
  });

  return {
    setSelection(selection) {
      if (destroyed) return;
      desiredSelection = selection;
      applySelection();
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
      stopDrag();
      stopCreated();
      stopUpdated();
      stopReady();
      wave.destroy();
    }
  };
}
