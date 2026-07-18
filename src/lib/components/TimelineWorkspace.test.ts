import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TimelineWorkspace from './TimelineWorkspace.svelte';

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
    await Promise.resolve();

    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(screen.getByTestId('timeline-content')).toHaveStyle({ width: '1250px' });
    expect(viewport.scrollLeft).toBeCloseTo(62.5);
  });

  it('renders rulers, loop selection, waveform slot, and rulers in the required order', () => {
    renderTimeline();
    const content = screen.getByTestId('timeline-content');
    const layers = Array.from(content.children).map((element) => element.getAttribute('data-timeline-layer'));

    expect(layers).toEqual(['top-ruler', 'loop-selection', 'waveform', 'bottom-ruler']);
    expect(content.querySelectorAll('.time-ruler')).toHaveLength(2);
    expect(Array.from(content.querySelectorAll<HTMLElement>('.time-ruler')).map((ruler) => ruler.style.width)).toEqual(['1000px', '1000px']);
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
});
