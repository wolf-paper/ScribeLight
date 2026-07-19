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
  const silentMedia = document.createElement('audio');
  const wave = factory({
    container,
    peaks: peaks.channels,
    duration: peaks.durationMs / 1_000,
    media: silentMedia,
    autoplay: false,
    interact: true,
    dragToSeek: false,
    waveColor: '#66758a',
    progressColor: '#8ba8d8',
    cursorWidth: 0,
    normalize: true
  });
  const regions = wave.registerPlugin(Regions.create());
  let region: ReturnType<typeof regions.addRegion> | null = null;
  let syncing = false;
  let destroyed = false;
  const stopDrag = regions.enableDragSelection(regionOptions);

  const reportUserSelection = (next: typeof region): void => {
    if (destroyed || syncing || !next || next !== region) return;
    onchange(normalizeRegion(next.start, next.end, peaks.durationMs));
  };
  const stopCreated = regions.on('region-created', (next) => {
    if (destroyed || syncing) return;
    if (region && region !== next) region.remove();
    region = next;
    reportUserSelection(next);
  });
  const stopUpdated = regions.on('region-updated', reportUserSelection);

  return {
    setSelection(selection) {
      if (destroyed) return;
      syncing = true;
      if (!selection) {
        regions.clearRegions();
        region = null;
      } else if (region) {
        region.setOptions({ start: selection.startMs / 1_000, end: selection.endMs / 1_000 });
      } else {
        region = regions.addRegion({
          ...regionOptions,
          start: selection.startMs / 1_000,
          end: selection.endMs / 1_000
        });
      }
      syncing = false;
    },
    setPlayhead(milliseconds) {
      if (!destroyed) wave.setTime(milliseconds / 1_000);
    },
    setZoom(pixelsPerSecond) {
      if (!destroyed) wave.zoom(pixelsPerSecond);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopDrag();
      stopCreated();
      stopUpdated();
      wave.destroy();
    }
  };
}
