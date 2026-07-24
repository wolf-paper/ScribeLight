import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PaletteSelector from './PaletteSelector.svelte';

describe('PaletteSelector', () => {
  it('shows the approved palettes and reports the selected palette', async () => {
    const onchange = vi.fn();

    render(PaletteSelector, { value: 'ion-magenta', onchange });

    const select = screen.getByRole('combobox', { name: 'Palette' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Ion Magenta',
      'Neon Ember',
      'Mercury Vapor',
      'Argon Current',
      'Xenon Arc',
      'Krypton Glow',
      'Sodium Vapor',
      'Oxygen Pearl'
    ]);
    expect(select).toHaveValue('ion-magenta');
    expect(screen.queryByRole('option', { name: 'Arctic Steel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ultraviolet Grid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Crimson Scope' })).not.toBeInTheDocument();

    await fireEvent.change(select, { target: { value: 'mercury-vapor' } });

    expect(onchange).toHaveBeenCalledWith('mercury-vapor');
  });
});
