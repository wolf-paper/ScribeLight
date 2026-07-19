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

const shortPeaks: PeakData = {
  ...peaks,
  totalFrames: 9_600,
  durationMs: 200
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
    addRegion: vi.fn((options: { id: string; start: number; end: number; color?: string }) => {
      const region: RegionDouble = {
        id: options.id,
        start: options.start,
        end: options.end,
        setOptions: vi.fn((next: { start?: number; end?: number; color?: string }) => {
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
    setOptions: vi.fn(),
    zoom: vi.fn(),
    destroy: vi.fn()
  };
  let factoryOptions: unknown;
  const factory = vi.fn((options: unknown) => {
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

type PaletteTokens = Record<
  '--color-waveform' | '--color-waveform-active' | '--color-playhead' | '--color-selection-region',
  string
>;

function mockPaletteTokens(container: HTMLElement, tokens: PaletteTokens) {
  const nativeGetComputedStyle = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => (
    element === container
      ? { getPropertyValue: (name: string) => tokens[name as keyof PaletteTokens] ?? '' } as unknown as CSSStyleDeclaration
      : nativeGetComputedStyle(element, pseudoElement)
  ));
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

    adapter.destroy();
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

    adapter.destroy();
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

    adapter.destroy();
  });

  it('does not stretch a capped sub-second waveform beyond the shared duration width', () => {
    const fixture = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), shortPeaks, vi.fn(), fixture.factory);
    const options = fixture.factoryOptions as Record<string, unknown>;

    expect(options.duration).toBe(0.2);
    expect(options.fillParent).toBe(false);

    adapter.setSelection({ startMs: 50, endMs: 200 });
    adapter.setPlayhead(200);
    adapter.setZoom(1_000);
    fixture.waveListeners.get('ready')?.();

    expect(fixture.wave.zoom).toHaveBeenCalledWith(1_000);
    expect(fixture.regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({ start: 0.05, end: 0.2 }));
    expect(fixture.renderer.renderProgress).toHaveBeenCalledWith(1, false);

    adapter.destroy();
  });

  it('resolves semantic palette tokens when WaveSurfer and Regions are created', () => {
    const fixture = createDouble();
    const container = document.body.appendChild(document.createElement('div'));
    const tokens: PaletteTokens = {
      '--color-waveform': '#101112',
      '--color-waveform-active': '#202122',
      '--color-playhead': '#303132',
      '--color-selection-region': 'rgb(40 41 42 / .28)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, vi.fn(), fixture.factory);

    expect(fixture.factoryOptions).toMatchObject({
      waveColor: '#101112',
      progressColor: '#202122',
      cursorColor: '#303132'
    });
    adapter.setSelection({ startMs: 100, endMs: 200 });
    fixture.waveListeners.get('ready')?.();
    expect(fixture.regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({
      color: 'rgb(40 41 42 / .28)'
    }));

    adapter.destroy();
    computedStyle.mockRestore();
    container.remove();
  });

  it('updates WaveSurfer and the existing region on live palette changes without recreating state', async () => {
    const fixture = createDouble();
    const container = document.body.appendChild(document.createElement('div'));
    const tokens: PaletteTokens = {
      '--color-waveform': '#111111',
      '--color-waveform-active': '#222222',
      '--color-playhead': '#333333',
      '--color-selection-region': 'rgb(44 44 44 / .28)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, vi.fn(), fixture.factory);
    adapter.setSelection({ startMs: 125, endMs: 375 });
    fixture.waveListeners.get('ready')?.();
    const canonical = fixture.regions.addRegion.mock.results[0]?.value as RegionDouble;

    tokens['--color-waveform'] = '#aaaaaa';
    tokens['--color-waveform-active'] = '#bbbbbb';
    tokens['--color-playhead'] = '#cccccc';
    tokens['--color-selection-region'] = 'rgb(221 221 221 / .34)';
    document.documentElement.dataset.palette = 'arctic-steel';

    await vi.waitFor(() => expect(fixture.wave.setOptions).toHaveBeenLastCalledWith({
      waveColor: '#aaaaaa',
      progressColor: '#bbbbbb',
      cursorColor: '#cccccc'
    }));
    expect(canonical.setOptions).toHaveBeenLastCalledWith({ color: 'rgb(221 221 221 / .34)' });
    expect(fixture.factory).toHaveBeenCalledOnce();
    expect(fixture.wave.registerPlugin).toHaveBeenCalledOnce();
    expect(fixture.regions.addRegion).toHaveBeenCalledOnce();
    expect(fixture.regions.clearRegions).not.toHaveBeenCalled();
    expect(canonical).toMatchObject({ start: 0.125, end: 0.375 });

    adapter.destroy();
    computedStyle.mockRestore();
    container.remove();
    delete document.documentElement.dataset.palette;
  });

  it('disconnects palette observation, stops listeners, and destroys only once', () => {
    const { disposers, regions, wave } = createDouble();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, vi.fn(), () => wave as never);
    const stopDrag = regions.enableDragSelection.mock.results[0]?.value as ReturnType<typeof vi.fn>;

    adapter.destroy();
    adapter.destroy();

    expect(stopDrag).toHaveBeenCalledOnce();
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).toHaveBeenCalledOnce();
    expect(disposers[2]).toHaveBeenCalledOnce();
    expect(disposers[3]).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(wave.destroy).toHaveBeenCalledOnce();
  });
});
