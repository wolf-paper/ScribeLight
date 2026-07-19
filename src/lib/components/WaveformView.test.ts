import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import WaveformView from './WaveformView.svelte';
import type { PeakData } from '../bridge/native';

const initialPeaks: PeakData = {
  durationMs: 1_000,
  sampleRate: 1_000,
  framesPerPeak: 10,
  channels: [[-1, 0, 1]]
};

describe('WaveformView', () => {
  it('creates a renderer after mount, forwards reactive props, replaces changed peaks, and cleans up once', async () => {
    const first = { setSelection: vi.fn(), setPlayhead: vi.fn(), setZoom: vi.fn(), destroy: vi.fn() };
    const second = { setSelection: vi.fn(), setPlayhead: vi.fn(), setZoom: vi.fn(), destroy: vi.fn() };
    const createAdapter = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onchange = vi.fn();
    const view = render(WaveformView, {
      peaks: initialPeaks,
      selection: { startMs: 100, endMs: 200 },
      playheadMs: 50,
      pixelsPerSecond: 125,
      onchange,
      createAdapter
    });

    expect(screen.getByRole('img', { name: 'Audio waveform' })).toBeInTheDocument();
    expect(createAdapter).toHaveBeenCalledWith(expect.any(HTMLDivElement), initialPeaks, onchange);
    expect(first.setSelection).toHaveBeenCalledWith({ startMs: 100, endMs: 200 });
    expect(first.setPlayhead).toHaveBeenCalledWith(50);
    expect(first.setZoom).toHaveBeenCalledWith(125);

    const replacement = { ...initialPeaks, channels: [[0, 1, 0]] };
    await view.rerender({ peaks: replacement, selection: { startMs: 300, endMs: 400 }, playheadMs: 75, pixelsPerSecond: 200 });

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(createAdapter).toHaveBeenLastCalledWith(expect.any(HTMLDivElement), replacement, onchange);
    expect(second.setSelection).toHaveBeenCalledWith({ startMs: 300, endMs: 400 });
    expect(second.setPlayhead).toHaveBeenCalledWith(75);
    expect(second.setZoom).toHaveBeenCalledWith(200);

    view.unmount();
    expect(second.destroy).toHaveBeenCalledOnce();
  });
});
