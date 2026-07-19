import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ClipToolbar from './ClipToolbar.svelte';

function actions() {
  return {
    open: vi.fn(), importTsv: vi.fn(), togglePlay: vi.fn(), toggleLoop: vi.fn(),
    toggleFormat: vi.fn(), exportTsv: vi.fn(), cancelAnalysis: vi.fn(), setVolume: vi.fn(),
    setMultilinePolicy: vi.fn()
  };
}

describe('ClipToolbar', () => {
  it('exposes playback, looping, volume, import, format, and export actions', async () => {
    const handlers = actions();
    render(ClipToolbar, {
      filename: 'clip.wav', playing: false, loopEnabled: true, canLoop: true,
      format: 'seconds', multilinePolicy: 'escape', volume: 1, analysisPercent: null, actions: handlers
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop on' }));
    await fireEvent.input(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '0.4' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Show clock time' }));
    const multilinePolicy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(multilinePolicy).toHaveTextContent('Escape line breaks as \\n');
    expect(multilinePolicy).toHaveTextContent('Replace line breaks with spaces');
    expect(multilinePolicy).toHaveTextContent('Preserve line breaks in quoted fields');
    await fireEvent.change(multilinePolicy, { target: { value: 'quoted' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
    expect(handlers.togglePlay).toHaveBeenCalledTimes(1);
    expect(handlers.toggleLoop).toHaveBeenCalledTimes(1);
    expect(handlers.setVolume).toHaveBeenCalledWith(0.4);
    expect(handlers.importTsv).toHaveBeenCalledTimes(1);
    expect(handlers.toggleFormat).toHaveBeenCalledTimes(1);
    expect(handlers.setMultilinePolicy).toHaveBeenCalledWith('quoted');
    expect(handlers.exportTsv).toHaveBeenCalledTimes(1);
  });

  it('disables clip actions appropriately and exposes cancellable finite progress', async () => {
    const handlers = actions();
    render(ClipToolbar, {
      filename: null, playing: false, loopEnabled: false, canLoop: false,
      format: 'clock', multilinePolicy: 'space', volume: 1, analysisPercent: 0, actions: handlers
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Loop off' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import TSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export TSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show decimal seconds' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toBeDisabled();
    expect(screen.getByRole('progressbar', { name: 'Waveform analysis progress' })).toHaveAttribute('aria-valuenow', '0');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel analysis' }));
    expect(handlers.cancelAnalysis).toHaveBeenCalledTimes(1);
  });

  it('disables policy-dependent file actions while a multiline setting is saving', () => {
    render(ClipToolbar, {
      filename: 'clip.wav', playing: false, loopEnabled: false, canLoop: true,
      format: 'seconds', multilinePolicy: 'escape', settingsBusy: true, actions: actions()
    });

    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import TSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export TSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  });
});
