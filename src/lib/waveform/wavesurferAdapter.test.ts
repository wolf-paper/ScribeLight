import { describe, expect, it, vi } from 'vitest';
import { createWaveformAdapter, type WaveformInteractionHandlers } from './wavesurferAdapter';
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
  element: HTMLDivElement;
  options: Record<string, unknown>;
  setOptions: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit(event: 'over' | 'leave', mouse?: MouseEvent): void;
}

function createHandlers(): WaveformInteractionHandlers {
  return {
    onSelectionChange: vi.fn(),
    onAnnotationPreview: vi.fn(),
    onAnnotationActivate: vi.fn()
  };
}

function createDouble() {
  const regionListeners = new Map<string, (region: RegionDouble, event?: MouseEvent) => void>();
  const waveListeners = new Map<string, () => void>();
  const pluginDisposers = new Map<string, ReturnType<typeof vi.fn>>();
  const waveDisposers = new Map<string, ReturnType<typeof vi.fn>>();
  const interactionDisposers: ReturnType<typeof vi.fn>[] = [];
  const renderer = { renderProgress: vi.fn() };
  const createdRegions: RegionDouble[] = [];
  const regions = {
    addRegion: vi.fn((options: Record<string, unknown> & { id: string; start: number; end: number }) => {
      const element = document.createElement('div');
      const interactionListeners = new Map<string, (mouse?: MouseEvent) => void>();
      const region: RegionDouble = {
        id: options.id,
        start: options.start,
        end: options.end,
        element,
        options: { ...options },
        setOptions: vi.fn((next: { start?: number; end?: number; color?: string }) => {
          Object.assign(region.options, next);
          region.start = next.start ?? region.start;
          region.end = next.end ?? region.end;
          regionListeners.get('region-updated')?.(region);
        }),
        remove: vi.fn(() => element.remove()),
        on: vi.fn((event: 'over' | 'leave', listener: (mouse?: MouseEvent) => void) => {
          interactionListeners.set(event, listener);
          const dispose = vi.fn(() => interactionListeners.delete(event));
          interactionDisposers.push(dispose);
          return dispose;
        }),
        emit(event, mouse) {
          interactionListeners.get(event)?.(mouse);
        }
      };
      createdRegions.push(region);
      return region;
    }),
    clearRegions: vi.fn(),
    enableDragSelection: vi.fn(() => vi.fn()),
    on: vi.fn((event: string, listener: (region: RegionDouble, event?: MouseEvent) => void) => {
      regionListeners.set(event, listener);
      const dispose = vi.fn(() => regionListeners.delete(event));
      pluginDisposers.set(event, dispose);
      return dispose;
    }),
    emit(event: string, region: RegionDouble, eventObject?: MouseEvent) {
      regionListeners.get(event)?.(region, eventObject);
    }
  };
  const wave = {
    registerPlugin: vi.fn(() => regions),
    on: vi.fn((event: string, listener: () => void) => {
      waveListeners.set(event, listener);
      const dispose = vi.fn(() => waveListeners.delete(event));
      waveDisposers.set(event, dispose);
      return dispose;
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
    pluginDisposers,
    waveDisposers,
    interactionDisposers,
    renderer,
    createdRegions,
    regions,
    wave
  };
}

type PaletteTokens = Record<
  | '--color-waveform'
  | '--color-waveform-active'
  | '--color-playhead'
  | '--color-selection-region'
  | '--color-annotation-region'
  | '--color-annotation-preview',
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
    const handlers = createHandlers();
    const changed = handlers.onSelectionChange;
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, factory);

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
    const handlers = createHandlers();
    const changed = handlers.onSelectionChange;
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, factory);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    waveListeners.get('ready')?.();
    const canonical = regions.addRegion.mock.results[0]?.value as RegionDouble;
    regionListeners.get('region-initialized')?.(canonical);
    regionListeners.get('region-created')?.(canonical);
    const userRegion: RegionDouble = {
      id: 'user-region',
      start: -0.4,
      end: 0,
      element: document.createElement('div'),
      options: {},
      setOptions: vi.fn(),
      remove: vi.fn(),
      on: vi.fn(),
      emit: vi.fn()
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
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, createHandlers(), fixture.factory);
    const options = fixture.factoryOptions as Record<string, unknown>;

    expect(options.interact).toBe(false);
    expect(options.cursorWidth).toBe(2);
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
    const adapter = createWaveformAdapter(document.createElement('div'), shortPeaks, createHandlers(), fixture.factory);
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
      '--color-selection-region': 'rgb(40 41 42 / .28)',
      '--color-annotation-region': 'rgb(40 41 42 / .12)',
      '--color-annotation-preview': 'rgb(40 41 42 / .42)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, createHandlers(), fixture.factory);

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
      '--color-selection-region': 'rgb(44 44 44 / .28)',
      '--color-annotation-region': 'rgb(44 44 44 / .12)',
      '--color-annotation-preview': 'rgb(44 44 44 / .42)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, createHandlers(), fixture.factory);
    adapter.setSelection({ startMs: 125, endMs: 375 });
    adapter.setAnnotations([{ id: 'saved', startMs: 200, endMs: 400 }]);
    adapter.setPreviewAnnotation('saved');
    fixture.waveListeners.get('ready')?.();
    const canonical = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'selection')!;
    const passive = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'annotation')!;
    const preview = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'preview')!;

    tokens['--color-waveform'] = '#aaaaaa';
    tokens['--color-waveform-active'] = '#bbbbbb';
    tokens['--color-playhead'] = '#cccccc';
    tokens['--color-selection-region'] = 'rgb(221 221 221 / .34)';
    tokens['--color-annotation-region'] = 'rgb(221 221 221 / .14)';
    tokens['--color-annotation-preview'] = 'rgb(221 221 221 / .46)';
    document.documentElement.dataset.palette = 'xenon-arc';

    await vi.waitFor(() => expect(fixture.wave.setOptions).toHaveBeenLastCalledWith({
      waveColor: '#aaaaaa',
      progressColor: '#bbbbbb',
      cursorColor: '#cccccc'
    }));
    expect(canonical.setOptions).toHaveBeenLastCalledWith({ color: 'rgb(221 221 221 / .34)' });
    expect(passive.setOptions).toHaveBeenLastCalledWith({ color: 'rgb(221 221 221 / .14)' });
    expect(preview.setOptions).toHaveBeenLastCalledWith({ color: 'rgb(221 221 221 / .46)' });
    expect(fixture.factory).toHaveBeenCalledOnce();
    expect(fixture.wave.registerPlugin).toHaveBeenCalledOnce();
    expect(fixture.regions.addRegion).toHaveBeenCalledTimes(3);
    expect(fixture.regions.clearRegions).not.toHaveBeenCalled();
    expect(canonical).toMatchObject({ start: 0.125, end: 0.375 });

    adapter.destroy();
    computedStyle.mockRestore();
    container.remove();
    delete document.documentElement.dataset.palette;
  });

  it('diffs pending passive annotations by ID without disturbing the canonical selection', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const changed = handlers.onSelectionChange;
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);

    adapter.setSelection({ startMs: 50, endMs: 150 });
    adapter.setAnnotations([
      { id: 'a', startMs: 100, endMs: 300 },
      { id: 'b', startMs: 200, endMs: 400 }
    ]);
    expect(fixture.regions.addRegion).not.toHaveBeenCalled();

    fixture.waveListeners.get('ready')?.();
    const canonical = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'selection')!;
    const passive = fixture.createdRegions.filter(({ element }) => element.dataset.lightscribeRegion === 'annotation');
    expect(passive).toHaveLength(2);
    expect(passive[0].options).toMatchObject({
      id: 'lightscribe-annotation-a', start: .1, end: .3, drag: false, resize: false
    });
    expect(passive[0].element.dataset.annotationId).toBe('a');
    expect(passive[0].element.style.pointerEvents).toBe('all');
    expect(passive[0].element.style.cursor).toBe('pointer');
    expect(passive[0].element.style.zIndex).toBe('1');
    expect(canonical.element.dataset.lightscribeRegion).toBe('selection');
    expect(canonical.element.style.zIndex).toBe('2');

    adapter.setAnnotations([
      { id: 'a', startMs: 125, endMs: 325 },
      { id: 'c', startMs: 500, endMs: 750 }
    ]);
    const a = passive.find(({ element }) => element.dataset.annotationId === 'a')!;
    const b = passive.find(({ element }) => element.dataset.annotationId === 'b')!;
    const c = fixture.createdRegions.find(({ element }) => element.dataset.annotationId === 'c')!;
    expect(a).toBe(passive[0]);
    expect(a.setOptions).toHaveBeenLastCalledWith(expect.objectContaining({ start: .125, end: .325 }));
    expect(b.remove).toHaveBeenCalledOnce();
    expect(c.options).toMatchObject({ start: .5, end: .75, drag: false, resize: false });
    expect(canonical.remove).not.toHaveBeenCalled();
    expect(canonical).toMatchObject({ start: .05, end: .15 });
    expect(fixture.regions.clearRegions).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();

    adapter.setSelection(null);
    expect(canonical.remove).toHaveBeenCalledOnce();
    expect(a.remove).not.toHaveBeenCalled();
    expect(c.remove).not.toHaveBeenCalled();
    expect(fixture.regions.clearRegions).not.toHaveBeenCalled();

    adapter.destroy();
  });

  it('reports passive hover intents, preserves stale leaves, and activates only on passive double-click', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 25, endMs: 75 });
    adapter.setAnnotations([
      { id: 'a', startMs: 100, endMs: 300 },
      { id: 'b', startMs: 200, endMs: 400 }
    ]);
    adapter.setPreviewAnnotation('a');
    fixture.waveListeners.get('ready')?.();
    const passive = fixture.createdRegions.filter(({ element }) =>
      element.dataset.lightscribeRegion === 'annotation'
    );
    const a = passive.find(({ element }) => element.dataset.annotationId === 'a')!;
    const b = passive.find(({ element }) => element.dataset.annotationId === 'b')!;
    const canonical = fixture.createdRegions.find(({ element }) =>
      element.dataset.lightscribeRegion === 'selection'
    )!;
    const preview = fixture.createdRegions.find(({ element }) =>
      element.dataset.lightscribeRegion === 'preview'
    )!;

    expect(a.options).toMatchObject({ drag: false, resize: false });
    expect(a.element.style.pointerEvents).toBe('all');
    expect(a.element.style.cursor).toBe('pointer');
    a.emit('over');
    expect(handlers.onAnnotationPreview).toHaveBeenLastCalledWith('a', true);
    a.emit('leave');
    expect(handlers.onAnnotationPreview).toHaveBeenLastCalledWith('a', false);

    vi.mocked(handlers.onAnnotationPreview).mockClear();
    a.emit('over');
    b.emit('over');
    a.emit('leave');
    expect(vi.mocked(handlers.onAnnotationPreview).mock.calls).toEqual([
      ['a', true],
      ['b', true],
      ['a', false]
    ]);

    vi.mocked(handlers.onSelectionChange).mockClear();
    vi.mocked(handlers.onAnnotationPreview).mockClear();
    vi.mocked(handlers.onAnnotationActivate).mockClear();
    fixture.regions.emit('region-clicked', a, new MouseEvent('click'));
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();
    expect(handlers.onAnnotationPreview).not.toHaveBeenCalled();
    expect(handlers.onAnnotationActivate).not.toHaveBeenCalled();

    const doubleClick = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as MouseEvent;
    fixture.regions.emit('region-double-clicked', a, doubleClick);
    expect(handlers.onAnnotationActivate).toHaveBeenCalledOnce();
    expect(handlers.onAnnotationActivate).toHaveBeenLastCalledWith('a');
    expect(doubleClick.preventDefault).toHaveBeenCalledOnce();
    expect(doubleClick.stopPropagation).toHaveBeenCalledOnce();
    fixture.regions.emit('region-double-clicked', canonical, new MouseEvent('dblclick'));
    fixture.regions.emit('region-double-clicked', preview, new MouseEvent('dblclick'));
    expect(handlers.onAnnotationActivate).toHaveBeenCalledOnce();

    adapter.destroy();
  });

  it('stops passive interactions on removal and replacement and stops every interaction on destroy', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setAnnotations([
      { id: 'a', startMs: 100, endMs: 300 },
      { id: 'b', startMs: 200, endMs: 400 }
    ]);
    fixture.waveListeners.get('ready')?.();
    const a = fixture.createdRegions.find(({ element }) => element.dataset.annotationId === 'a')!;
    const b = fixture.createdRegions.find(({ element }) => element.dataset.annotationId === 'b')!;
    const [stopAOver, stopALeave, stopBOver, stopBLeave] = fixture.interactionDisposers;
    const oldDoubleClick = fixture.regionListeners.get('region-double-clicked')!;

    adapter.setAnnotations([{ id: 'b', startMs: 225, endMs: 425 }]);
    expect(stopAOver).toHaveBeenCalledOnce();
    expect(stopALeave).toHaveBeenCalledOnce();
    a.emit('over');
    a.emit('leave');
    expect(handlers.onAnnotationPreview).not.toHaveBeenCalled();

    adapter.setAnnotations([{ id: 'c', startMs: 500, endMs: 700 }]);
    expect(stopBOver).toHaveBeenCalledOnce();
    expect(stopBLeave).toHaveBeenCalledOnce();
    b.emit('over');
    const c = fixture.createdRegions.find(({ element }) => element.dataset.annotationId === 'c')!;
    const [stopCOver, stopCLeave] = fixture.interactionDisposers.slice(4);

    adapter.destroy();
    adapter.destroy();
    expect(stopAOver).toHaveBeenCalledOnce();
    expect(stopALeave).toHaveBeenCalledOnce();
    expect(stopBOver).toHaveBeenCalledOnce();
    expect(stopBLeave).toHaveBeenCalledOnce();
    expect(stopCOver).toHaveBeenCalledOnce();
    expect(stopCLeave).toHaveBeenCalledOnce();
    expect(fixture.pluginDisposers.get('region-double-clicked')).toHaveBeenCalledOnce();

    c.emit('over');
    oldDoubleClick(c, new MouseEvent('dblclick'));
    expect(handlers.onAnnotationPreview).not.toHaveBeenCalled();
    expect(handlers.onAnnotationActivate).not.toHaveBeenCalled();
  });

  it('keeps one non-interactive preview above other layers and clears stale preview identity', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const changed = handlers.onSelectionChange;
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 25, endMs: 75 });
    adapter.setAnnotations([
      { id: 'a', startMs: 100, endMs: 300 },
      { id: 'c', startMs: 500, endMs: 700 }
    ]);
    fixture.waveListeners.get('ready')?.();
    const canonical = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'selection')!;

    adapter.setPreviewAnnotation('a');
    const previewA = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'preview')!;
    expect(previewA.options).toMatchObject({
      id: 'lightscribe-annotation-preview', start: .1, end: .3, drag: false, resize: false
    });
    expect(previewA.element.dataset.annotationId).toBe('a');
    expect(previewA.element.style.pointerEvents).toBe('none');
    expect(previewA.element.style.zIndex).toBe('3');

    adapter.setAnnotations([
      { id: 'a', startMs: 150, endMs: 350 },
      { id: 'c', startMs: 500, endMs: 700 }
    ]);
    expect(previewA.setOptions).toHaveBeenLastCalledWith(expect.objectContaining({ start: .15, end: .35 }));
    expect(previewA.remove).not.toHaveBeenCalled();

    adapter.setPreviewAnnotation('c');
    const previews = fixture.createdRegions.filter(({ element }) => element.dataset.lightscribeRegion === 'preview');
    const previewC = previews.at(-1)!;
    expect(previews).toHaveLength(2);
    expect(previewA.remove).toHaveBeenCalledOnce();
    expect(previewC).not.toBe(previewA);
    expect(previewC.options).toMatchObject({ start: .5, end: .7 });
    expect(previews.filter(({ remove }) => !remove.mock.calls.length)).toEqual([previewC]);
    expect(canonical).toMatchObject({ start: .025, end: .075 });
    expect(changed).not.toHaveBeenCalled();

    adapter.setAnnotations([{ id: 'a', startMs: 150, endMs: 350 }]);
    expect(previewC.remove).toHaveBeenCalledOnce();
    expect(previews.filter(({ remove }) => !remove.mock.calls.length)).toHaveLength(0);

    adapter.setPreviewAnnotation(null);
    expect(previewC.remove).toHaveBeenCalledOnce();
    adapter.destroy();
  });

  it('never promotes or reports managed passive and preview region events', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const changed = handlers.onSelectionChange;
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([{ id: 'a', startMs: 300, endMs: 400 }]);
    adapter.setPreviewAnnotation('a');
    fixture.waveListeners.get('ready')?.();
    const canonical = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'selection')!;
    const passive = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'annotation')!;
    const preview = fixture.createdRegions.find(({ element }) => element.dataset.lightscribeRegion === 'preview')!;

    for (const managed of [passive, preview]) {
      fixture.regionListeners.get('region-initialized')?.(managed);
      fixture.regionListeners.get('region-created')?.(managed);
      fixture.regionListeners.get('region-updated')?.(managed);
    }

    expect(canonical.remove).not.toHaveBeenCalled();
    expect(passive.remove).not.toHaveBeenCalled();
    expect(preview.remove).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it('disconnects palette observation, stops listeners, and destroys only once', () => {
    const fixture = createDouble();
    const { pluginDisposers, waveDisposers, regions, wave } = fixture;
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, createHandlers(), () => wave as never);
    const stopDrag = regions.enableDragSelection.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([{ id: 'a', startMs: 300, endMs: 400 }]);
    adapter.setPreviewAnnotation('a');
    fixture.waveListeners.get('ready')?.();
    const managed = [...fixture.createdRegions];

    adapter.destroy();
    adapter.destroy();

    for (const region of managed) expect(region.remove).toHaveBeenCalledOnce();
    expect(stopDrag).toHaveBeenCalledOnce();
    expect(pluginDisposers.get('region-initialized')).toHaveBeenCalledOnce();
    expect(pluginDisposers.get('region-created')).toHaveBeenCalledOnce();
    expect(pluginDisposers.get('region-updated')).toHaveBeenCalledOnce();
    expect(waveDisposers.get('ready')).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(wave.destroy).toHaveBeenCalledOnce();
  });
});
