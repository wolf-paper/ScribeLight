import { describe, expect, it, vi } from 'vitest';
import { createWaveformAdapter } from './wavesurferAdapter';
import type { PeakData } from '../bridge/native';

const peaks: PeakData = {
  durationMs: 1_000,
  sampleRate: 1_000,
  framesPerPeak: 10,
  channels: [[-1, 0, 1]]
};

function createDouble() {
  const listeners = new Map<string, (region: RegionDouble) => void>();
  const disposers = [vi.fn(), vi.fn()];
  const regions = {
    addRegion: vi.fn(() => createRegion()),
    clearRegions: vi.fn(),
    enableDragSelection: vi.fn(() => vi.fn()),
    on: vi.fn((event: string, listener: (region: RegionDouble) => void) => {
      listeners.set(event, listener);
      return disposers[listeners.size - 1];
    })
  };
  const wave = {
    registerPlugin: vi.fn(() => regions),
    setTime: vi.fn(),
    zoom: vi.fn(),
    destroy: vi.fn()
  };

  return { listeners, disposers, regions, wave };
}

interface RegionDouble {
  start: number;
  end: number;
  setOptions: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function createRegion(start = 0, end = 0): RegionDouble {
  return { start, end, setOptions: vi.fn(), remove: vi.fn() };
}

describe('createWaveformAdapter', () => {
  it('creates, updates, and clears one visual region without programmatic feedback', () => {
    const { regions, wave } = createDouble();
    const changed = vi.fn();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, changed, () => wave as never);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    const region = regions.addRegion.mock.results[0]?.value as RegionDouble;
    expect(regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({ start: 0.1, end: 0.2 }));
    expect(changed).not.toHaveBeenCalled();

    adapter.setSelection({ startMs: 110, endMs: 210 });
    expect(region.setOptions).toHaveBeenCalledWith({ start: 0.11, end: 0.21 });
    expect(changed).not.toHaveBeenCalled();

    adapter.setSelection(null);
    expect(regions.clearRegions).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it('normalizes clamped integer-millisecond edits and replaces a second drag region', () => {
    const { listeners, regions, wave } = createDouble();
    const changed = vi.fn();
    createWaveformAdapter(document.createElement('div'), peaks, changed, () => wave as never);
    const first = createRegion(0.3334, 0.3336);
    const second = createRegion(-0.4, 0);

    listeners.get('region-created')?.(first);
    first.start = 0.9996;
    first.end = 2;
    listeners.get('region-updated')?.(first);
    listeners.get('region-created')?.(second);

    expect(changed).toHaveBeenNthCalledWith(1, { startMs: 333, endMs: 334 });
    expect(changed).toHaveBeenNthCalledWith(2, { startMs: 999, endMs: 1_000 });
    expect(first.remove).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenNthCalledWith(3, { startMs: 0, endMs: 1 });
    expect(regions.addRegion).not.toHaveBeenCalled();
  });

  it('forwards renderer-only playhead and synchronized zoom updates', () => {
    const { wave } = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, vi.fn(), () => wave as never);

    adapter.setPlayhead(275);
    adapter.setZoom(250);

    expect(wave.setTime).toHaveBeenCalledWith(0.275);
    expect(wave.zoom).toHaveBeenCalledWith(250);
  });

  it('stops drag selection, unsubscribes listeners, and destroys only once', () => {
    const { disposers, regions, wave } = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, vi.fn(), () => wave as never);
    const stopDrag = regions.enableDragSelection.mock.results[0]?.value as ReturnType<typeof vi.fn>;

    adapter.destroy();
    adapter.destroy();

    expect(stopDrag).toHaveBeenCalledOnce();
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).toHaveBeenCalledOnce();
    expect(wave.destroy).toHaveBeenCalledOnce();
  });
});
