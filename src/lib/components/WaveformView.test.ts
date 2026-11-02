import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import WaveformView from './WaveformView.svelte';
import type { PeakData } from '../bridge/native';
import type { WaveformAnnotation } from '../waveform/wavesurferAdapter';

const initialPeaks: PeakData = {
  totalFrames: 48_000,
  durationMs: 1_000,
  sampleRate: 1_000,
  framesPerPeak: 10,
  channels: [[-1, 0, 1]]
};

const adapterDouble = () => ({
  setSelection: vi.fn(), setAnnotations: vi.fn(), setActiveAnnotation: vi.fn(), setPreviewAnnotation: vi.fn(),
  setPlayhead: vi.fn(), setZoom: vi.fn(), destroy: vi.fn()
});

describe('WaveformView', () => {
  it('creates a renderer after mount, forwards reactive props, replaces changed peaks, and cleans up once', async () => {
    const annotations: readonly WaveformAnnotation[] = [
      { id: 'a', startMs: 100, endMs: 300, label: 'A' },
      { id: 'b', startMs: 200, endMs: 400, label: '' }
    ];
    const first = adapterDouble();
    const second = adapterDouble();
    const createAdapter = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handlers = {
      onchange: vi.fn(),
      oncreate: vi.fn(),
      onseek: vi.fn(),
      onannotationpreview: vi.fn(),
      onannotationactivate: vi.fn()
    };
    const interactions = {
      onSelectionChange: handlers.onchange,
      onSelectionCreate: handlers.oncreate,
      onSeek: handlers.onseek,
      onAnnotationPreview: handlers.onannotationpreview,
      onAnnotationActivate: handlers.onannotationactivate
    };
    const view = render(WaveformView, {
      peaks: initialPeaks,
      selection: { startMs: 100, endMs: 200 },
      playheadMs: 50,
      pixelsPerSecond: 125,
      annotations,
      activeAnnotationId: 'a',
      previewAnnotationId: 'b',
      ...handlers,
      createAdapter
    });

    expect(screen.getByRole('img', { name: 'Audio waveform' })).toBeInTheDocument();
    expect(createAdapter).toHaveBeenCalledWith(expect.any(HTMLDivElement), initialPeaks, interactions);
    expect(first.setAnnotations).toHaveBeenCalledWith(annotations);
    expect(first.setActiveAnnotation).toHaveBeenCalledWith('a');
    expect(first.setPreviewAnnotation).toHaveBeenCalledWith('b');
    expect(first.setSelection).toHaveBeenCalledWith({ startMs: 100, endMs: 200 });
    expect(first.setPlayhead).toHaveBeenCalledWith(50);
    expect(first.setZoom).toHaveBeenCalledWith(125);

    await view.rerender({ playheadMs: 60 });
    expect(first.setPlayhead).toHaveBeenLastCalledWith(60);
    expect(first.setZoom).toHaveBeenCalledOnce();
    expect(first.setActiveAnnotation).toHaveBeenCalledOnce();
    expect(first.setPreviewAnnotation).toHaveBeenCalledOnce();

    const replacement = { ...initialPeaks, channels: [[0, 1, 0]] };
    const updatedAnnotations: readonly WaveformAnnotation[] = [
      annotations[0],
      { ...annotations[1], endMs: 450 }
    ];
    await view.rerender({
      peaks: replacement,
      selection: { startMs: 300, endMs: 400 },
      playheadMs: 75,
      pixelsPerSecond: 200,
      annotations: updatedAnnotations,
      activeAnnotationId: null,
      previewAnnotationId: null
    });

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(createAdapter).toHaveBeenLastCalledWith(expect.any(HTMLDivElement), replacement, interactions);
    expect(second.setAnnotations).toHaveBeenCalledWith(updatedAnnotations);
    expect(second.setActiveAnnotation).toHaveBeenCalledWith(null);
    expect(second.setPreviewAnnotation).toHaveBeenCalledWith(null);
    expect(second.setSelection).toHaveBeenCalledWith({ startMs: 300, endMs: 400 });
    expect(second.setPlayhead).toHaveBeenCalledWith(75);
    expect(second.setZoom).toHaveBeenCalledWith(200);

    view.unmount();
    expect(second.destroy).toHaveBeenCalledOnce();
  });
});
