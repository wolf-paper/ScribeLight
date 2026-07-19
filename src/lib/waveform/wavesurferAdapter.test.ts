import { describe, expect, it, vi } from 'vitest';
import { createWaveformAdapter } from './wavesurferAdapter';
import type { PeakData } from '../bridge/native';

const peaks: PeakData = {
  totalFrames: 48_000,
  durationMs: 1_000,
  sampleRate: 1_000,
  framesPerPeak: 10,
  channels: [[-1, 0, 1]]
};

interface RegionDouble {
  id: string;
  start: number;
  end: number;
  setOptions: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function createDouble() {
  const regionListeners = new Map<string, (region: RegionDouble) => void>();
  const waveListeners = new Map<string, () => void>();
  const disposers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const renderer = { renderProgress: vi.fn() };
  const regions = {
    addRegion: vi.fn((options: { id: string; start: number; end: number }) => {
      const region: RegionDouble = {
        id: options.id,
        start: options.start,
        end: options.end,
        setOptions: vi.fn((next: { start?: number; end?: number }) => {
          region.start = next.start ?? region.start;
          region.end = next.end ?? region.end;
          regionListeners.get('region-updated')?.(region);
        }),
        remove: vi.fn()
      };
      return region;
    }),
    clearRegions: vi.fn(),
    enableDragSelection: vi.fn(() => vi.fn()),
    on: vi.fn((event: string, listener: (region: RegionDouble) => void) => {
      regionListeners.set(event, listener);
      return disposers[regionListeners.size - 1];
    })
  };
  const wave = {
    registerPlugin: vi.fn(() => regions),
    on: vi.fn((event: string, listener: () => void) => {
      waveListeners.set(event, listener);
      return disposers[3];
    }),
    getRenderer: vi.fn(() => renderer),
    zoom: vi.fn(),
    destroy: vi.fn()
  };
  let factoryOptions: unknown;
  const factory = ((options: unknown) => {
    factoryOptions = options;
    return wave as never;
  }) as never;

  return {
    factory,
    get factoryOptions() { return factoryOptions; },
    regionListeners,
    waveListeners,
    disposers,
    renderer,
    regions,
    wave
  };
}

describe('createWaveformAdapter', () => {
  it('waits for ready and uses only the latest canonical selection after clear and replacement', () => {
    const { factory, regionListeners, waveListeners, regions } = createDouble();
    const changed = vi.fn();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, changed, factory);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setSelection(null);
    adapter.setSelection({ startMs: 300, endMs: 400 });
    expect(regions.addRegion).not.toHaveBeenCalled();

    waveListeners.get('ready')?.();
    expect(regions.addRegion).toHaveBeenCalledOnce();
    expect(regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({
      id: 'lightscribe-canonical-selection',
      start: 0.3,
      end: 0.4
    }));
    const canonical = regions.addRegion.mock.results[0]?.value as RegionDouble;
    regionListeners.get('region-created')?.(canonical);
    expect(changed).not.toHaveBeenCalled();

    adapter.setSelection({ startMs: 350, endMs: 450 });
    expect(canonical.setOptions).toHaveBeenCalledWith({ start: 0.35, end: 0.45 });
    expect(changed).not.toHaveBeenCalled();

    canonical.start = 0.3334;
    canonical.end = 0.3336;
    regionListeners.get('region-updated')?.(canonical);
    expect(changed).toHaveBeenCalledWith({ startMs: 333, endMs: 334 });
  });

  it('removes the prior region as a second user drag starts, then emits once when it completes', () => {
    const { factory, regionListeners, waveListeners, regions } = createDouble();
    const changed = vi.fn();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, changed, factory);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    waveListeners.get('ready')?.();
    const canonical = regions.addRegion.mock.results[0]?.value as RegionDouble;
    regionListeners.get('region-initialized')?.(canonical);
    regionListeners.get('region-created')?.(canonical);
    const userRegion: RegionDouble = {
      id: 'user-region',
      start: -0.4,
      end: 0,
      setOptions: vi.fn(),
      remove: vi.fn()
    };

    regionListeners.get('region-initialized')?.(userRegion);
    expect(canonical.remove).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();

    regionListeners.get('region-created')?.(userRegion);
    expect(changed).toHaveBeenLastCalledWith({ startMs: 0, endMs: 1 });
    expect(changed).toHaveBeenCalledOnce();

    userRegion.start = 0.9996;
    userRegion.end = 2;
    regionListeners.get('region-updated')?.(userRegion);
    expect(changed).toHaveBeenLastCalledWith({ startMs: 999, endMs: 1_000 });
  });

  it('keeps WaveSurfer renderer-only and applies pending playhead and zoom after ready', () => {
    const fixture = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, vi.fn(), fixture.factory);
    const options = fixture.factoryOptions as Record<string, unknown>;

    expect(options.interact).toBe(false);
    expect(options).not.toHaveProperty('media');
    adapter.setPlayhead(275);
    adapter.setZoom(250);
    expect(fixture.renderer.renderProgress).not.toHaveBeenCalled();
    expect(fixture.wave.zoom).not.toHaveBeenCalled();

    fixture.waveListeners.get('ready')?.();
    expect(fixture.renderer.renderProgress).toHaveBeenCalledWith(0.275, false);
    expect(fixture.wave.zoom).toHaveBeenCalledWith(250);
    adapter.setPlayhead(2_000);
    expect(fixture.renderer.renderProgress).toHaveBeenLastCalledWith(1, false);
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
    expect(disposers[2]).toHaveBeenCalledOnce();
    expect(disposers[3]).toHaveBeenCalledOnce();
    expect(wave.destroy).toHaveBeenCalledOnce();
  });
});
