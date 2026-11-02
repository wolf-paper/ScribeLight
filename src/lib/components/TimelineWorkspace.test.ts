import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TimelineWorkspace from './TimelineWorkspace.svelte';
import { fakePeaks } from '../../test/fakeBridge';
import type { WaveformInteractionHandlers } from '../waveform/wavesurferAdapter';

const waveformAdapter = vi.hoisted(() => ({
  setSelection: vi.fn(),
  setAnnotations: vi.fn(),
  setActiveAnnotation: vi.fn(),
  setPreviewAnnotation: vi.fn(),
  setPlayhead: vi.fn(),
  setZoom: vi.fn(),
  destroy: vi.fn()
}));
const waveformFactory = vi.hoisted(() => ({
  interactions: null as null | WaveformInteractionHandlers
}));

vi.mock('../waveform/wavesurferAdapter', () => ({
  createWaveformAdapter: (_container: HTMLElement, _peaks: unknown, interactions: WaveformInteractionHandlers) => {
    waveformFactory.interactions = interactions;
    return waveformAdapter;
  }
}));

afterEach(() => vi.restoreAllMocks());

type TimelineProps = Record<string, unknown>;

function renderTimeline(props: TimelineProps = {}, viewportWidth = 500) {
  const handlers = {
    onchange: vi.fn(),
    oncreate: vi.fn(),
    onseek: vi.fn(),
    onannotationpreview: vi.fn(),
    onannotationactivate: vi.fn()
  };
  const view = render(TimelineWorkspace, {
    durationMs: 10_000,
    selection: { startMs: 100, endMs: 200 },
    ...handlers,
    ...props
  });
  const viewport = screen.getByTestId('timeline-viewport');
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: viewportWidth });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
    bottom: 0, height: 0, left: 0, right: viewportWidth, top: 0, width: viewportWidth, x: 0, y: 0,
    toJSON: () => ({})
  });
  return { ...handlers, view, viewport };
}

/** Replaces `scrollLeft` with a value clamped to the rendered content, as a browser does. */
function trackScroll(viewport: HTMLElement) {
  const content = screen.getByTestId('timeline-content');
  let scrollLeft = 0;
  const assignments: number[] = [];
  Object.defineProperty(viewport, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = Math.min(value, Math.max(0, Number.parseFloat(content.style.width) - viewport.clientWidth));
      assignments.push(scrollLeft);
    }
  });
  return {
    assignments,
    userScroll(value: number) {
      scrollLeft = value;
      viewport.dispatchEvent(new Event('scroll'));
    }
  };
}

async function measured(): Promise<void> {
  window.dispatchEvent(new Event('resize'));
  await Promise.resolve();
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const layerNames = () => Array.from(screen.getByTestId('timeline-content').querySelectorAll('[data-timeline-layer]'))
  .map((element) => element.getAttribute('data-timeline-layer'));

describe('TimelineWorkspace', () => {
  it('zooms only for Ctrl+wheel, prevents browser zoom, and synchronizes the width', async () => {
    const { viewport } = renderTimeline();
    const ordinaryWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 250, deltaY: -100 });
    viewport.dispatchEvent(ordinaryWheel);

    expect(ordinaryWheel.defaultPrevented).toBe(false);
    expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1000px' });

    const zoomWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 250, ctrlKey: true, deltaY: -100 });
    viewport.dispatchEvent(zoomWheel);

    expect(zoomWheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1250px' }));
    await waitFor(() => expect(viewport.scrollLeft).toBeCloseTo(62.5));
  });

  it('renders one compact ruler above the loop bar and waveform, without a header or zoom hint', () => {
    renderTimeline();
    const content = screen.getByTestId('timeline-content');

    expect(layerNames()).toEqual(['ruler', 'loop-selection', 'waveform']);
    expect(content.querySelectorAll('.time-ruler')).toHaveLength(1);
    expect(content.querySelector<HTMLElement>('.time-ruler')?.style.width).toBe('1000px');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Ctrl + wheel to zoom')).not.toBeInTheDocument();
    expect(Array.from(content.querySelectorAll('.tick')).slice(0, 3).map((tick) => tick.textContent))
      .toEqual(['0:00', '0:01', '0:02']);
  });

  it('forwards saved annotations, active and preview state, and maps waveform gestures to callbacks', async () => {
    const annotations = [
      { id: 'a', startMs: 1_000, endMs: 2_000, label: 'Speaker A' },
      { id: 'b', startMs: 1_500, endMs: 2_500, label: '' }
    ];
    const { onchange, oncreate, onseek, onannotationpreview, onannotationactivate, viewport } = renderTimeline({
      peaks: fakePeaks(10_000),
      annotations,
      activeAnnotationId: 'a',
      previewAnnotationId: 'b'
    });

    await waitFor(() => {
      expect(waveformAdapter.setAnnotations).toHaveBeenCalledWith(annotations);
      expect(waveformAdapter.setActiveAnnotation).toHaveBeenCalledWith('a');
      expect(waveformAdapter.setPreviewAnnotation).toHaveBeenCalledWith('b');
    });
    const interactions = waveformFactory.interactions!;
    interactions.onAnnotationPreview('a', true);
    interactions.onAnnotationActivate('b');
    interactions.onSeek(4_321);
    interactions.onSelectionCreate({ startMs: 1_200, endMs: 1_800 });
    interactions.onSelectionChange({ startMs: 150, endMs: 250 });
    expect(onannotationpreview).toHaveBeenCalledWith('a', true);
    expect(onannotationactivate).toHaveBeenCalledWith('b');
    expect(onseek).toHaveBeenCalledWith(4_321);
    expect(oncreate).toHaveBeenCalledExactlyOnceWith({ startMs: 1_200, endMs: 1_800 });
    expect(onchange).toHaveBeenCalledExactlyOnceWith({ startMs: 150, endMs: 250 });
    expect(layerNames()).toEqual(['ruler', 'loop-selection', 'waveform']);

    const zoomWheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: 250, ctrlKey: true, deltaY: -100
    });
    viewport.dispatchEvent(zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1250px' }));
  });

  it('offers separate controls and clamps integer-millisecond handle and body drags', async () => {
    const { onchange } = renderTimeline({ selection: { startMs: 100, endMs: 300 } });
    const start = screen.getByRole('button', { name: 'Resize loop start' });
    const body = screen.getByRole('button', { name: 'Move loop selection' });
    const end = screen.getByRole('button', { name: 'Resize loop end' });

    expect(start.parentElement).not.toBe(body);
    expect(end.parentElement).not.toBe(body);

    await fireEvent.pointerDown(start, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(screen.getByLabelText('Loop selection'), { clientX: 129.6, pointerId: 1 });
    await fireEvent.pointerUp(screen.getByLabelText('Loop selection'), { pointerId: 1 });
    expect(onchange).toHaveBeenLastCalledWith({ startMs: 299, endMs: 300 });

    await fireEvent.pointerDown(end, { clientX: 100, pointerId: 2 });
    await fireEvent.pointerMove(screen.getByLabelText('Loop selection'), { clientX: -1000, pointerId: 2 });
    await fireEvent.pointerCancel(screen.getByLabelText('Loop selection'), { pointerId: 2 });
    expect(onchange).toHaveBeenLastCalledWith({ startMs: 100, endMs: 101 });

    await fireEvent.pointerDown(body, { clientX: 100, pointerId: 3 });
    await fireEvent.pointerMove(screen.getByLabelText('Loop selection'), { clientX: 2000, pointerId: 3 });
    await fireEvent.lostPointerCapture(screen.getByLabelText('Loop selection'), { pointerId: 3 });
    expect(onchange).toHaveBeenLastCalledWith({ startMs: 9_800, endMs: 10_000 });
  });

  it('seeks on a ruler press and scrubs once per animation frame while dragging', async () => {
    const { onseek } = renderTimeline({ playheadMs: 0 });
    const ruler = screen.getByTestId('timeline-content').querySelector<HTMLElement>('[data-timeline-layer="ruler"]')!;

    await fireEvent.pointerDown(ruler, { clientX: 250, pointerId: 7, button: 0 });
    expect(onseek.mock.calls).toEqual([[2_500]]);

    await fireEvent.pointerMove(window, { clientX: 300, pointerId: 7 });
    await fireEvent.pointerMove(window, { clientX: 320.4, pointerId: 7 });
    await fireEvent.pointerMove(window, { clientX: 999, pointerId: 8 });
    expect(onseek).toHaveBeenCalledOnce();
    await nextFrame();
    expect(onseek.mock.calls).toEqual([[2_500], [3_204]]);

    await fireEvent.pointerMove(window, { clientX: 5_000, pointerId: 7 });
    await fireEvent.pointerUp(window, { clientX: 5_000, pointerId: 7 });
    expect(onseek).toHaveBeenLastCalledWith(10_000);
    await fireEvent.pointerMove(window, { clientX: 100, pointerId: 7 });
    await nextFrame();
    expect(onseek).toHaveBeenCalledTimes(3);

    await fireEvent.pointerDown(ruler, { clientX: 100, pointerId: 9, button: 2 });
    expect(onseek).toHaveBeenCalledTimes(3);
  });

  it('scrubs by dragging the playhead grip without jumping on press', async () => {
    const { onseek } = renderTimeline({ playheadMs: 4_000 });
    const grip = screen.getByTestId('timeline-playhead-grip');

    expect(grip).toHaveStyle({ transform: 'translateX(400px)' });
    expect(screen.getByTestId('timeline-playhead')).toHaveStyle({ transform: 'translateX(400px)' });
    await fireEvent.pointerDown(grip, { clientX: 403, pointerId: 1, button: 0 });
    expect(onseek).not.toHaveBeenCalled();

    await fireEvent.pointerMove(window, { clientX: 450, pointerId: 1 });
    await nextFrame();
    expect(onseek).toHaveBeenCalledExactlyOnceWith(4_500);
    await fireEvent.pointerCancel(window, { pointerId: 1 });
  });

  it('offers zoom buttons that zoom around a visible playhead, fit the whole clip, and mention Ctrl + wheel', async () => {
    const { viewport } = renderTimeline({ playheadMs: 3_000 });
    const tracked = trackScroll(viewport);
    await measured();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const fit = screen.getByRole('button', { name: 'Fit whole clip' });

    for (const button of [zoomIn, zoomOut, fit]) expect(button.title).toMatch(/Ctrl \+ wheel/);
    expect(screen.getByRole('group', { name: 'Timeline zoom' })).toContainElement(zoomIn);

    await fireEvent.click(zoomIn);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '2000px' }));
    await waitFor(() => expect(viewport.scrollLeft).toBe(300));

    await fireEvent.click(zoomOut);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1000px' }));

    await fireEvent.click(fit);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '500px' }));
    expect(tracked.assignments.at(-1)).toBe(0);
    expect(zoomOut).toBeDisabled();
    expect(fit).toBeDisabled();
    expect(zoomIn).toBeEnabled();
  });

  it('disables the zoom buttons while the timeline is disabled', async () => {
    renderTimeline({ disabled: true });
    await measured();

    for (const name of ['Zoom in', 'Zoom out', 'Fit whole clip']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('reveals a requested range by centring it only when it is not fully visible and its key changes', async () => {
    const { view, viewport } = renderTimeline({ durationMs: 60_000 });
    const tracked = trackScroll(viewport);
    await measured();

    await view.rerender({ reveal: { startMs: 10_000, endMs: 11_000, key: 1 } });
    await waitFor(() => expect(viewport.scrollLeft).toBe(800));

    await view.rerender({ reveal: { startMs: 50_000, endMs: 51_000, key: 1 } });
    await view.rerender({ reveal: { startMs: 10_200, endMs: 10_400, key: 2 } });
    await Promise.resolve();
    expect(tracked.assignments).toEqual([800]);

    await view.rerender({ reveal: { startMs: 0, endMs: 100, key: 3 } });
    await waitFor(() => expect(viewport.scrollLeft).toBe(0));
  });

  it('pages to keep the playhead in view while playing, but not right after a manual scroll', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const { view, viewport } = renderTimeline({ durationMs: 60_000, playheadMs: 0, playing: false });
    const tracked = trackScroll(viewport);
    await measured();

    await view.rerender({ playheadMs: 6_000 });
    await Promise.resolve();
    expect(tracked.assignments).toEqual([]);

    await view.rerender({ playing: true });
    await waitFor(() => expect(viewport.scrollLeft).toBe(550));
    await view.rerender({ playheadMs: 9_000 });
    await Promise.resolve();
    expect(tracked.assignments).toEqual([550]);

    tracked.userScroll(100);
    await view.rerender({ playheadMs: 30_000 });
    now.mockReturnValue(11_400);
    await view.rerender({ playheadMs: 30_100 });
    await Promise.resolve();
    expect(viewport.scrollLeft).toBe(100);

    now.mockReturnValue(11_600);
    await view.rerender({ playheadMs: 30_200 });
    await waitFor(() => expect(viewport.scrollLeft).toBe(2_970));
  });

  it('does not create invalid dimensions for a zero duration or unmeasurable viewport', () => {
    render(TimelineWorkspace, {
      durationMs: 0, selection: null, onchange: vi.fn(), oncreate: vi.fn(), onseek: vi.fn(),
      onannotationpreview: vi.fn(), onannotationactivate: vi.fn()
    });

    const content = screen.getByTestId('timeline-content');
    expect(content).toHaveStyle({ width: '0px' });
    expect(content.getAttribute('style')).not.toMatch(/NaN|Infinity/);
  });

  it('keeps every layer at one effective width before and after measuring a zero-length viewport', async () => {
    render(TimelineWorkspace, {
      durationMs: 0, selection: null, onchange: vi.fn(), oncreate: vi.fn(), onseek: vi.fn(),
      onannotationpreview: vi.fn(), onannotationactivate: vi.fn()
    });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 500 });

    const layerWidths = () => Array.from(
      screen.getByTestId('timeline-content').querySelectorAll<HTMLElement>('[data-timeline-layer]')
    ).map((layer) => layer.style.width);
    expect(layerWidths()).toEqual(['0px', '0px', '0px']);

    await measured();

    expect(screen.getByTestId('timeline-scroll-surface')).toHaveStyle({ width: '500px' });
    expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '0px' });
    expect(layerWidths()).toEqual(['0px', '0px', '0px']);
  });

  it('keeps a capped sub-second clip on one exact time-to-pixel scale without collapsing the viewport', async () => {
    renderTimeline({ durationMs: 200, selection: { startMs: 50, endMs: 200 }, playheadMs: 200 }, 900);

    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-scroll-surface')).toHaveStyle({ width: '900px' });
      expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '200px' });
    });

    const content = screen.getByTestId('timeline-content');
    const layers = Array.from(content.querySelectorAll<HTMLElement>('[data-timeline-layer]'));
    expect(layers.map((layer) => layer.style.width)).toEqual(['200px', '200px', '200px']);

    const ticks = Array.from(content.querySelectorAll<HTMLElement>('[data-timeline-layer="ruler"] .tick'));
    expect(ticks.map((tick) => [tick.style.left, tick.textContent])).toEqual([['0px', '0:00'], ['100px', '0:00.1']]);
    expect(screen.getByLabelText('Loop selection').querySelector('.selection')).toHaveStyle({
      left: '50px',
      width: '150px'
    });
    expect(screen.getByTestId('timeline-playhead')).toHaveStyle({ transform: 'translateX(200px)' });
  });

  it('initializes a short nonempty clip at the measured whole-clip fit zoom', async () => {
    renderTimeline({ durationMs: 1_000 });

    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '500px' });
      expect(screen.getByLabelText('Loop selection').querySelector('.selection')).toHaveStyle({ width: '50px' });
    });
  });

  it('applies right-edge scroll after the zoomed width is rendered', async () => {
    const { viewport } = renderTimeline();
    const content = screen.getByTestId('timeline-content');
    const assignmentWidths: string[] = [];
    let scrollLeft = 0;
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        assignmentWidths.push(content.style.width);
        scrollLeft = Math.min(value, Math.max(0, Number.parseFloat(content.style.width) - viewport.clientWidth));
      }
    });
    viewport.scrollLeft = 500;
    assignmentWidths.length = 0;

    viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      ctrlKey: true,
      deltaY: -100
    }));
    await waitFor(() => {
      expect(assignmentWidths).toEqual(['1250px']);
      expect(viewport.scrollLeft).toBe(750);
    });
  });

  it('applies only the latest deferred scroll target for rapid consecutive Ctrl+wheel zooms', async () => {
    const { viewport } = renderTimeline();
    const content = screen.getByTestId('timeline-content');
    const assignmentWidths: string[] = [];
    let scrollLeft = 0;
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        assignmentWidths.push(content.style.width);
        scrollLeft = Math.min(value, Math.max(0, Number.parseFloat(content.style.width) - viewport.clientWidth));
      }
    });

    for (let index = 0; index < 2; index += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 250,
        ctrlKey: true,
        deltaY: -100
      }));
    }

    await waitFor(() => {
      expect(assignmentWidths).toEqual(['1562.5px']);
      expect(viewport.scrollLeft).toBeCloseTo(140.625);
    });
  });
});
