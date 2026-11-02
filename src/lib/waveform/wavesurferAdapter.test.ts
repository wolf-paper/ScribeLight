import { describe, expect, it, vi } from 'vitest';
import {
  createWaveformAdapter,
  type WaveformAnnotation,
  type WaveformInteractionHandlers
} from './wavesurferAdapter';
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
}

function createHandlers() {
  return {
    onSelectionChange: vi.fn(),
    onSelectionCreate: vi.fn(),
    onSeek: vi.fn(),
    onAnnotationPreview: vi.fn(),
    onAnnotationActivate: vi.fn()
  } satisfies WaveformInteractionHandlers;
}

const annotation = (id: string, startMs: number, endMs: number, label = ''): WaveformAnnotation => ({
  id, startMs, endMs, label
});

function createDouble() {
  const regionListeners = new Map<string, (region: RegionDouble) => void>();
  const waveListeners = new Map<string, () => void>();
  const pluginDisposers = new Map<string, ReturnType<typeof vi.fn>>();
  const waveDisposers = new Map<string, ReturnType<typeof vi.fn>>();
  const renderer = { renderProgress: vi.fn() };
  const createdRegions: RegionDouble[] = [];
  // 1 px per millisecond for the 1 s clip.
  const wrapper = document.createElement('div');
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
    bottom: 100, height: 100, left: 0, right: 1_000, top: 0, width: 1_000, x: 0, y: 0, toJSON: () => ({})
  });
  const regions = {
    addRegion: vi.fn((options: Record<string, unknown> & { id: string; start: number; end: number }) => {
      const element = document.createElement('div');
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
        remove: vi.fn(() => element.remove())
      };
      createdRegions.push(region);
      return region;
    }),
    clearRegions: vi.fn(),
    enableDragSelection: vi.fn(() => vi.fn()),
    on: vi.fn((event: string, listener: (region: RegionDouble) => void) => {
      regionListeners.set(event, listener);
      const dispose = vi.fn(() => regionListeners.delete(event));
      pluginDisposers.set(event, dispose);
      return dispose;
    })
  };
  const wave = {
    registerPlugin: vi.fn(() => regions),
    getWrapper: vi.fn(() => wrapper),
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
    renderer,
    createdRegions,
    regions,
    wave,
    wrapper,
    byKind: (kind: 'selection' | 'annotation' | 'preview') =>
      createdRegions.filter(({ element }) => element.dataset.scribelightRegion === kind),
    annotationRegion: (id: string) =>
      createdRegions.find(({ element }) => element.dataset.annotationId === id
        && element.dataset.scribelightRegion === 'annotation')!
  };
}

function click(target: Element, clientX: number, button = 0): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, button }));
}

function hover(target: Element, clientX: number, buttons = 0): void {
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, buttons }));
}

type PaletteTokens = Record<
  | '--color-waveform'
  | '--color-waveform-active'
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
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, factory);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setSelection(null);
    adapter.setSelection({ startMs: 300, endMs: 400 });
    expect(regions.addRegion).not.toHaveBeenCalled();

    waveListeners.get('ready')?.();
    expect(regions.addRegion).toHaveBeenCalledOnce();
    expect(regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({
      id: 'scribelight-canonical-selection',
      start: 0.3,
      end: 0.4
    }));
    const canonical = regions.addRegion.mock.results[0]?.value as RegionDouble;
    regionListeners.get('region-created')?.(canonical);
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();
    expect(handlers.onSelectionCreate).not.toHaveBeenCalled();

    adapter.setSelection({ startMs: 350, endMs: 450 });
    expect(canonical.setOptions).toHaveBeenCalledWith({ start: 0.35, end: 0.45 });
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();

    canonical.start = 0.3334;
    canonical.end = 0.3336;
    regionListeners.get('region-updated')?.(canonical);
    expect(handlers.onSelectionChange).toHaveBeenCalledWith({ startMs: 333, endMs: 334 });
    expect(handlers.onSelectionCreate).not.toHaveBeenCalled();

    adapter.destroy();
  });

  it('replaces the selection as a drag starts and reports the dragged range as a new range', () => {
    const { factory, regionListeners, waveListeners, regions } = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, factory);

    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([annotation('saved', 0, 900)]);
    waveListeners.get('ready')?.();
    const canonical = regions.addRegion.mock.results.map(({ value }) => value as RegionDouble)
      .find(({ id }) => id === 'scribelight-canonical-selection')!;
    const userRegion: RegionDouble = {
      id: 'user-region',
      start: -0.4,
      end: 0,
      element: document.createElement('div'),
      options: {},
      setOptions: vi.fn(),
      remove: vi.fn()
    };

    regionListeners.get('region-initialized')?.(userRegion);
    expect(canonical.remove).toHaveBeenCalledOnce();
    expect(userRegion.element.dataset.scribelightRegion).toBe('selection');
    expect(handlers.onSelectionCreate).not.toHaveBeenCalled();

    regionListeners.get('region-created')?.(userRegion);
    expect(handlers.onSelectionCreate).toHaveBeenCalledExactlyOnceWith({ startMs: 0, endMs: 1 });
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();
    expect(handlers.onAnnotationActivate).not.toHaveBeenCalled();

    userRegion.start = 0.9996;
    userRegion.end = 2;
    regionListeners.get('region-updated')?.(userRegion);
    expect(handlers.onSelectionChange).toHaveBeenLastCalledWith({ startMs: 999, endMs: 1_000 });
    expect(handlers.onSelectionCreate).toHaveBeenCalledOnce();

    adapter.destroy();
  });

  it('reports exactly the dragged span, in either direction, instead of the plugin region that overshoots the pointer', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setAnnotations([annotation('saved', 100, 900)]);
    fixture.waveListeners.get('ready')?.();
    const drag = (fromX: number, toX: number, plugin: { start: number; end: number }) => {
      fixture.wrapper.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: fromX, button: 0 }));
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: (fromX + toX) / 2 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: toX }));
      const dragged = fixture.regions.addRegion({ id: `drag-${fromX}`, ...plugin });
      fixture.regionListeners.get('region-initialized')?.(dragged);
      fixture.regionListeners.get('region-created')?.(dragged);
      return dragged;
    };

    const rightward = drag(200, 350, { start: .2, end: .355 });
    expect(handlers.onSelectionCreate).toHaveBeenLastCalledWith({ startMs: 200, endMs: 350 });
    expect(rightward.setOptions).toHaveBeenCalledWith({ start: .2, end: .35 });
    expect(rightward.element.dataset.scribelightRegion).toBe('selection');

    const leftward = drag(600, 400.4, { start: .4, end: .605 });
    expect(handlers.onSelectionCreate).toHaveBeenLastCalledWith({ startMs: 400, endMs: 600 });
    expect(leftward.setOptions).toHaveBeenCalledWith({ start: .4, end: .6 });
    expect(rightward.remove).toHaveBeenCalledOnce();
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();
    expect(handlers.onAnnotationActivate).not.toHaveBeenCalled();

    adapter.destroy();
  });

  it('keeps WaveSurfer renderer-only, sized by its parent, and redraws against the external zoom after ready', () => {
    const fixture = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, createHandlers(), fixture.factory);
    const options = fixture.factoryOptions as Record<string, unknown>;

    expect(options.interact).toBe(false);
    expect(options.dragToSeek).toBe(false);
    expect(options.cursorWidth).toBe(0);
    expect(options.height).toBe('auto');
    expect(options.fillParent).toBe(true);
    expect(options.minPxPerSec).toBe(0);
    expect(options).not.toHaveProperty('media');
    adapter.setPlayhead(275);
    adapter.setZoom(250);
    expect(fixture.renderer.renderProgress).not.toHaveBeenCalled();
    expect(fixture.wave.setOptions).not.toHaveBeenCalled();
    expect(fixture.wave.zoom).not.toHaveBeenCalled();

    fixture.waveListeners.get('ready')?.();
    expect(fixture.renderer.renderProgress).toHaveBeenCalledWith(0.275, false);
    expect(fixture.wave.setOptions).toHaveBeenCalledOnce();
    expect(fixture.wave.setOptions).toHaveBeenCalledWith({ fillParent: true, minPxPerSec: 0 });
    expect(fixture.wave.zoom).not.toHaveBeenCalled();
    adapter.setZoom(250);
    expect(fixture.wave.setOptions).toHaveBeenCalledOnce();
    adapter.setPlayhead(2_000);
    expect(fixture.renderer.renderProgress).toHaveBeenLastCalledWith(1, false);

    adapter.destroy();
  });

  it('does not stretch a capped sub-second waveform beyond the shared duration width', () => {
    const fixture = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), shortPeaks, createHandlers(), fixture.factory);
    const options = fixture.factoryOptions as Record<string, unknown>;

    expect(options.duration).toBe(0.2);
    expect(options.fillParent).toBe(true);
    expect(options.minPxPerSec).toBe(0);

    adapter.setSelection({ startMs: 50, endMs: 200 });
    adapter.setPlayhead(200);
    adapter.setZoom(1_000);
    fixture.waveListeners.get('ready')?.();

    expect(fixture.wave.setOptions).toHaveBeenCalledWith({ fillParent: true, minPxPerSec: 0 });
    expect(fixture.wave.zoom).not.toHaveBeenCalled();
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
      '--color-selection-region': 'rgb(40 41 42 / .28)',
      '--color-annotation-region': 'rgb(40 41 42 / .12)',
      '--color-annotation-preview': 'rgb(40 41 42 / .42)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, createHandlers(), fixture.factory);

    expect(fixture.factoryOptions).toMatchObject({ waveColor: '#101112', progressColor: '#202122' });
    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([annotation('saved', 300, 400)]);
    fixture.waveListeners.get('ready')?.();
    expect(fixture.regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({ color: 'rgb(40 41 42 / .28)' }));
    expect(fixture.regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({ color: 'rgb(40 41 42 / .12)' }));

    adapter.destroy();
    computedStyle.mockRestore();
    container.remove();
  });

  it('updates WaveSurfer and the existing regions on live palette changes without recreating state', async () => {
    const fixture = createDouble();
    const container = document.body.appendChild(document.createElement('div'));
    const tokens: PaletteTokens = {
      '--color-waveform': '#111111',
      '--color-waveform-active': '#222222',
      '--color-selection-region': 'rgb(44 44 44 / .28)',
      '--color-annotation-region': 'rgb(44 44 44 / .12)',
      '--color-annotation-preview': 'rgb(44 44 44 / .42)'
    };
    const computedStyle = mockPaletteTokens(container, tokens);
    const adapter = createWaveformAdapter(container, peaks, createHandlers(), fixture.factory);
    adapter.setSelection({ startMs: 125, endMs: 375 });
    adapter.setAnnotations([annotation('saved', 200, 400)]);
    adapter.setPreviewAnnotation('saved');
    fixture.waveListeners.get('ready')?.();
    const [canonical] = fixture.byKind('selection');
    const [passive] = fixture.byKind('annotation');
    const [preview] = fixture.byKind('preview');

    tokens['--color-waveform'] = '#aaaaaa';
    tokens['--color-waveform-active'] = '#bbbbbb';
    tokens['--color-selection-region'] = 'rgb(221 221 221 / .34)';
    tokens['--color-annotation-region'] = 'rgb(221 221 221 / .14)';
    tokens['--color-annotation-preview'] = 'rgb(221 221 221 / .46)';
    document.documentElement.dataset.palette = 'xenon-arc';

    await vi.waitFor(() => expect(fixture.wave.setOptions).toHaveBeenLastCalledWith({
      waveColor: '#aaaaaa',
      progressColor: '#bbbbbb'
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

  it('diffs saved annotations by ID, lets pointer events pass through them, and leaves the selection alone', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);

    adapter.setSelection({ startMs: 50, endMs: 150 });
    adapter.setAnnotations([annotation('a', 100, 300), annotation('b', 200, 400)]);
    expect(fixture.regions.addRegion).not.toHaveBeenCalled();

    fixture.waveListeners.get('ready')?.();
    const [canonical] = fixture.byKind('selection');
    const passive = fixture.byKind('annotation');
    expect(passive).toHaveLength(2);
    expect(passive[0].options).toMatchObject({
      id: 'scribelight-annotation-a', start: .1, end: .3, drag: false, resize: false
    });
    expect(passive[0].element.dataset.annotationId).toBe('a');
    expect(passive[0].element.style.pointerEvents).toBe('none');
    expect(passive[0].element.style.zIndex).toBe('1');
    expect(canonical.element.style.zIndex).toBe('3');

    const a = fixture.annotationRegion('a');
    const b = fixture.annotationRegion('b');
    adapter.setAnnotations([annotation('a', 125, 325), annotation('b', 200, 400), annotation('c', 500, 750)]);
    expect(a.setOptions).toHaveBeenLastCalledWith({ start: .125, end: .325 });
    expect(b.setOptions).not.toHaveBeenCalled();

    adapter.setAnnotations([annotation('a', 125, 325), annotation('c', 500, 750)]);
    const c = fixture.annotationRegion('c');
    expect(a).toBe(passive[0]);
    expect(b.remove).toHaveBeenCalledOnce();
    expect(c.options).toMatchObject({ start: .5, end: .75, drag: false, resize: false });
    expect(canonical.remove).not.toHaveBeenCalled();
    expect(canonical).toMatchObject({ start: .05, end: .15 });
    expect(fixture.regions.clearRegions).not.toHaveBeenCalled();
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();

    adapter.setSelection(null);
    expect(canonical.remove).toHaveBeenCalledOnce();
    expect(a.remove).not.toHaveBeenCalled();
    expect(c.remove).not.toHaveBeenCalled();

    adapter.destroy();
  });

  it('maps a plain click to seek on the background or current selection and to activate on a saved annotation', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 600, endMs: 700 });
    adapter.setAnnotations([annotation('outer', 100, 500), annotation('inner', 200, 300), annotation('under', 600, 900)]);

    click(fixture.wrapper, 50);
    expect(handlers.onSeek).not.toHaveBeenCalled();

    fixture.waveListeners.get('ready')?.();
    click(fixture.wrapper, 50.4);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(50);

    click(fixture.wrapper, 150);
    expect(handlers.onAnnotationActivate).toHaveBeenLastCalledWith('outer');
    click(fixture.wrapper, 250);
    expect(handlers.onAnnotationActivate).toHaveBeenLastCalledWith('inner');

    const [canonical] = fixture.byKind('selection');
    fixture.wrapper.append(canonical.element);
    click(canonical.element, 650);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(650);
    click(fixture.wrapper, 800);
    expect(handlers.onAnnotationActivate).toHaveBeenLastCalledWith('under');

    click(fixture.wrapper, 1_500);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(1_000);
    click(fixture.wrapper, 150, 2);
    expect(handlers.onSeek).toHaveBeenCalledTimes(3);
    expect(handlers.onAnnotationActivate).toHaveBeenCalledTimes(3);
    expect(handlers.onSelectionCreate).not.toHaveBeenCalled();
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();

    adapter.destroy();
  });

  it('previews the saved annotation under the pointer with a pointer cursor and clears it on leave or press', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const container = document.createElement('div');
    const adapter = createWaveformAdapter(container, peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 700, endMs: 800 });
    adapter.setAnnotations([annotation('a', 100, 300), annotation('b', 250, 400), annotation('c', 650, 900)]);
    fixture.waveListeners.get('ready')?.();
    const preview = vi.mocked(handlers.onAnnotationPreview);

    hover(fixture.wrapper, 150);
    expect(preview.mock.calls).toEqual([['a', true]]);
    expect(container.style.cursor).toBe('pointer');
    hover(fixture.wrapper, 160);
    hover(fixture.wrapper, 275);
    hover(fixture.wrapper, 500);
    expect(preview.mock.calls).toEqual([['a', true], ['a', false], ['b', true], ['b', false]]);
    expect(container.style.cursor).toBe('');

    preview.mockClear();
    hover(fixture.wrapper, 660);
    const [canonical] = fixture.byKind('selection');
    fixture.wrapper.append(canonical.element);
    hover(canonical.element, 750);
    hover(fixture.wrapper, 660);
    fixture.wrapper.dispatchEvent(new MouseEvent('pointerleave'));
    hover(fixture.wrapper, 660);
    hover(fixture.wrapper, 670, 1);
    expect(preview.mock.calls).toEqual([
      ['c', true], ['c', false], ['c', true], ['c', false], ['c', true], ['c', false]
    ]);

    preview.mockClear();
    hover(fixture.wrapper, 150);
    adapter.setAnnotations([annotation('b', 250, 400)]);
    expect(preview.mock.calls).toEqual([['a', true], ['a', false]]);

    adapter.destroy();
  });

  it('marks the active annotation and labels regions wide enough at the current zoom in overlap lanes', () => {
    const fixture = createDouble();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, createHandlers(), fixture.factory);
    adapter.setAnnotations([
      annotation('a', 0, 500, 'Speaker A'),
      annotation('b', 100, 600, 'Speaker B'),
      annotation('c', 500, 900, 'Speaker C'),
      annotation('narrow', 900, 930, 'Narrow'),
      annotation('blank', 930, 1_000, '')
    ]);
    adapter.setZoom(100);
    fixture.waveListeners.get('ready')?.();
    const label = (id: string) => fixture.annotationRegion(id).element.querySelector<HTMLElement>('[part^="scribelight-annotation-label"]')!;
    const frame = (id: string) => fixture.annotationRegion(id).element.querySelector<HTMLElement>('[part^="scribelight-annotation"]')!;

    expect(label('a').textContent).toBe('Speaker A');
    expect(label('a').style.pointerEvents).toBe('none');
    expect(frame('a').style.pointerEvents).toBe('none');
    expect(['a', 'b', 'c', 'narrow', 'blank'].map((id) => label(id).style.display))
      .toEqual(['', '', '', 'none', 'none']);
    expect(['a', 'b', 'c'].map((id) => label(id).style.top)).toEqual(['0px', '14px', '0px']);
    expect(frame('a').getAttribute('part')).toBe('scribelight-annotation');

    adapter.setActiveAnnotation('b');
    expect(frame('b').getAttribute('part')).toBe('scribelight-annotation-active');
    expect(label('b').getAttribute('part')).toBe('scribelight-annotation-label-active');
    expect(fixture.annotationRegion('b').element.dataset.active).toBe('true');
    expect(fixture.annotationRegion('b').element.style.zIndex).toBe('2');
    expect(fixture.annotationRegion('a').element.dataset.active).toBeUndefined();

    adapter.setZoom(2_000);
    expect(label('narrow').style.display).toBe('');
    adapter.setZoom(90);
    expect(['a', 'b', 'c', 'narrow'].map((id) => label(id).style.display)).toEqual(['', '', 'none', 'none']);

    adapter.setActiveAnnotation(null);
    expect(frame('b').getAttribute('part')).toBe('scribelight-annotation');
    expect(fixture.annotationRegion('b').element.style.zIndex).toBe('1');
    adapter.setAnnotations([annotation('a', 0, 500, 'Renamed')]);
    expect(label('a').textContent).toBe('Renamed');

    adapter.destroy();
  });

  it('keeps one non-interactive preview above other layers and clears stale preview identity', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 25, endMs: 75 });
    adapter.setAnnotations([annotation('a', 100, 300), annotation('c', 500, 700)]);
    fixture.waveListeners.get('ready')?.();
    const [canonical] = fixture.byKind('selection');

    adapter.setPreviewAnnotation('a');
    const [previewA] = fixture.byKind('preview');
    expect(previewA.options).toMatchObject({
      id: 'scribelight-annotation-preview', start: .1, end: .3, drag: false, resize: false
    });
    expect(previewA.element.dataset.annotationId).toBe('a');
    expect(previewA.element.style.pointerEvents).toBe('none');
    expect(previewA.element.style.zIndex).toBe('4');

    adapter.setAnnotations([annotation('a', 150, 350), annotation('c', 500, 700)]);
    expect(previewA.setOptions).toHaveBeenLastCalledWith(expect.objectContaining({ start: .15, end: .35 }));
    expect(previewA.remove).not.toHaveBeenCalled();

    adapter.setPreviewAnnotation('c');
    const previews = fixture.byKind('preview');
    const previewC = previews.at(-1)!;
    expect(previews).toHaveLength(2);
    expect(previewA.remove).toHaveBeenCalledOnce();
    expect(previewC).not.toBe(previewA);
    expect(previewC.options).toMatchObject({ start: .5, end: .7 });
    expect(previews.filter(({ remove }) => !remove.mock.calls.length)).toEqual([previewC]);
    expect(canonical).toMatchObject({ start: .025, end: .075 });
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();

    adapter.setAnnotations([annotation('a', 150, 350)]);
    expect(previewC.remove).toHaveBeenCalledOnce();
    expect(previews.filter(({ remove }) => !remove.mock.calls.length)).toHaveLength(0);

    adapter.setPreviewAnnotation(null);
    expect(previewC.remove).toHaveBeenCalledOnce();
    adapter.destroy();
  });

  it('never promotes or reports managed passive and preview region events', () => {
    const fixture = createDouble();
    const handlers = createHandlers();
    const adapter = createWaveformAdapter(document.createElement('div'), peaks, handlers, fixture.factory);
    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([annotation('a', 300, 400)]);
    adapter.setPreviewAnnotation('a');
    fixture.waveListeners.get('ready')?.();
    const [canonical] = fixture.byKind('selection');
    const [passive] = fixture.byKind('annotation');
    const [preview] = fixture.byKind('preview');

    for (const managed of [passive, preview]) {
      fixture.regionListeners.get('region-initialized')?.(managed);
      fixture.regionListeners.get('region-created')?.(managed);
      fixture.regionListeners.get('region-updated')?.(managed);
    }

    expect(canonical.remove).not.toHaveBeenCalled();
    expect(passive.remove).not.toHaveBeenCalled();
    expect(preview.remove).not.toHaveBeenCalled();
    expect(handlers.onSelectionChange).not.toHaveBeenCalled();
    expect(handlers.onSelectionCreate).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it('disconnects observers, stops every listener and gesture, and destroys only once', () => {
    const fixture = createDouble();
    const { pluginDisposers, waveDisposers, regions, wave } = fixture;
    const handlers = createHandlers();
    const container = document.createElement('div');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const adapter = createWaveformAdapter(container, peaks, handlers, () => wave as never);
    const stopDrag = regions.enableDragSelection.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    adapter.setSelection({ startMs: 100, endMs: 200 });
    adapter.setAnnotations([annotation('a', 300, 400)]);
    adapter.setPreviewAnnotation('a');
    fixture.waveListeners.get('ready')?.();
    const managed = [...fixture.createdRegions];
    hover(fixture.wrapper, 350);
    expect(container.style.cursor).toBe('pointer');
    vi.mocked(handlers.onAnnotationPreview).mockClear();

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
    expect(container.style.cursor).toBe('');

    hover(fixture.wrapper, 380);
    click(fixture.wrapper, 350);
    click(fixture.wrapper, 50);
    expect(handlers.onAnnotationPreview).not.toHaveBeenCalled();
    expect(handlers.onAnnotationActivate).not.toHaveBeenCalled();
    expect(handlers.onSeek).not.toHaveBeenCalled();
    disconnect.mockRestore();
  });
});
