import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TimelineWorkspace from './TimelineWorkspace.svelte';
import { fakePeaks } from '../../test/fakeBridge';

const waveformAdapter = vi.hoisted(() => ({
  setSelection: vi.fn(),
  setAnnotations: vi.fn(),
  setPreviewAnnotation: vi.fn(),
  setPlayhead: vi.fn(),
  setZoom: vi.fn(),
  destroy: vi.fn()
}));

vi.mock('../waveform/wavesurferAdapter', () => ({
  createWaveformAdapter: () => waveformAdapter
}));

function renderTimeline(selection = { startMs: 100, endMs: 200 }) {
  const onchange = vi.fn();
  render(TimelineWorkspace, {
    durationMs: 10_000,
    format: 'seconds',
    selection,
    onchange
  });
  const viewport = screen.getByTestId('timeline-viewport');
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 500 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
    bottom: 0, height: 0, left: 0, right: 500, top: 0, width: 500, x: 0, y: 0,
    toJSON: () => ({})
  });
  return { onchange, viewport };
}

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

  it('renders the zoom hint and keeps rulers, loop selection, waveform, and rulers in the required order', () => {
    renderTimeline();
    const content = screen.getByTestId('timeline-content');
    const layers = Array.from(content.children).map((element) => element.getAttribute('data-timeline-layer'));

    expect(screen.getByText('Ctrl + wheel to zoom')).toBeInTheDocument();
    expect(layers).toEqual(['top-ruler', 'loop-selection', 'waveform', 'bottom-ruler']);
    expect(content.querySelectorAll('.time-ruler')).toHaveLength(2);
    expect(Array.from(content.querySelectorAll<HTMLElement>('.time-ruler')).map((ruler) => ruler.style.width)).toEqual(['1000px', '1000px']);
  });

  it('forwards saved annotations and preview state without changing layers or Ctrl+wheel zoom', async () => {
    const annotations = [
      { id: 'a', startMs: 1_000, endMs: 2_000 },
      { id: 'b', startMs: 1_500, endMs: 2_500 }
    ];
    const onchange = vi.fn();
    render(TimelineWorkspace, {
      durationMs: 10_000,
      format: 'seconds',
      selection: { startMs: 100, endMs: 200 },
      onchange,
      peaks: fakePeaks(10_000),
      annotations,
      previewAnnotationId: 'b'
    });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 500 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      bottom: 0, height: 0, left: 0, right: 500, top: 0, width: 500, x: 0, y: 0,
      toJSON: () => ({})
    });

    await waitFor(() => {
      expect(waveformAdapter.setAnnotations).toHaveBeenCalledWith(annotations);
      expect(waveformAdapter.setPreviewAnnotation).toHaveBeenCalledWith('b');
    });
    expect(Array.from(screen.getByTestId('timeline-content').children)
      .map((element) => element.getAttribute('data-timeline-layer')))
      .toEqual(['top-ruler', 'loop-selection', 'waveform', 'bottom-ruler']);

    const zoomWheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: 250, ctrlKey: true, deltaY: -100
    });
    viewport.dispatchEvent(zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1250px' }));
  });

  it('offers separate controls and clamps integer-millisecond handle and body drags', async () => {
    const { onchange } = renderTimeline({ startMs: 100, endMs: 300 });
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

  it('does not create invalid dimensions for a zero duration or unmeasurable viewport', () => {
    const onchange = vi.fn();
    render(TimelineWorkspace, { durationMs: 0, format: 'clock', selection: null, onchange });

    const content = screen.getByTestId('timeline-content');
    expect(content).toHaveStyle({ width: '0px' });
    expect(content.getAttribute('style')).not.toMatch(/NaN|Infinity/);
  });

  it('keeps every layer at one effective width before and after measuring a zero-length viewport', async () => {
    const onchange = vi.fn();
    render(TimelineWorkspace, { durationMs: 0, format: 'clock', selection: null, onchange });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 500 });

    const layerWidths = () => Array.from(
      screen.getByTestId('timeline-content').querySelectorAll<HTMLElement>('[data-timeline-layer]')
    ).map((layer) => layer.style.width);
    expect(layerWidths()).toEqual(['0px', '0px', '0px', '0px']);

    window.dispatchEvent(new Event('resize'));
    await Promise.resolve();

    expect(screen.getByTestId('timeline-scroll-surface')).toHaveStyle({ width: '500px' });
    expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '0px' });
    expect(layerWidths()).toEqual(['0px', '0px', '0px', '0px']);
  });

  it('keeps a capped sub-second clip on one exact time-to-pixel endpoint without collapsing the viewport', async () => {
    const onchange = vi.fn();
    render(TimelineWorkspace, {
      durationMs: 200,
      format: 'seconds',
      selection: { startMs: 50, endMs: 200 },
      playheadMs: 200,
      onchange
    });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 900 });

    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-scroll-surface')).toHaveStyle({ width: '900px' });
      expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '200px' });
    });

    const content = screen.getByTestId('timeline-content');
    const layers = Array.from(content.querySelectorAll<HTMLElement>('[data-timeline-layer]'));
    expect(layers.map((layer) => layer.style.width)).toEqual(['200px', '200px', '200px', '200px']);

    const topRulerTicks = content.querySelectorAll<HTMLElement>('[data-timeline-layer="top-ruler"] .tick');
    expect(topRulerTicks.item(topRulerTicks.length - 1)).toHaveStyle({ left: '200px' });
    expect(screen.getByLabelText('Loop selection').querySelector('.selection')).toHaveStyle({
      left: '50px',
      width: '150px'
    });
    expect(content.querySelector<HTMLElement>('[data-timeline-layer="waveform"]')).toHaveStyle({ width: '200px' });
  });

  it('initializes a short nonempty clip at the measured whole-clip fit zoom', async () => {
    const onchange = vi.fn();
    render(TimelineWorkspace, {
      durationMs: 1_000,
      format: 'seconds',
      selection: { startMs: 100, endMs: 200 },
      onchange
    });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 500 });

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
