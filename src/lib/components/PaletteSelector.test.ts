import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PaletteSelector from './PaletteSelector.svelte';

describe('PaletteSelector', () => {
  it('shows the four palettes and reports the selected palette', async () => {
    const onchange = vi.fn();

    render(PaletteSelector, { value: 'ion-magenta', onchange });

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: 'Ion Magenta' })).toBeChecked();

    await fireEvent.click(screen.getByRole('radio', { name: 'Arctic Steel' }));

    expect(onchange).toHaveBeenCalledWith('arctic-steel');
  });
});
