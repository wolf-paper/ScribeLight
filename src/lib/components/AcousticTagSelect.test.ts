import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { stableColorSlot } from '../theme/palette';
import AcousticTagSelect from './AcousticTagSelect.svelte';

const tags = [
  { id: 'quiet-id', label: 'quiet_dialogue' },
  { id: 'breath-id', label: 'breath' },
  { id: 'laugh-id', label: 'laugh' }
];

describe('AcousticTagSelect', () => {
  it('searches and toggles the active option from the keyboard', async () => {
    const onchange = vi.fn();
    render(AcousticTagSelect, { tags, selectedIds: [], onchange });

    const combobox = screen.getByRole('combobox', { name: 'Acoustic tags' });
    expect(combobox).toHaveAttribute('aria-haspopup', 'listbox');
    expect(combobox).toHaveAttribute('aria-expanded', 'false');

    await fireEvent.click(combobox);
    const search = screen.getByRole('searchbox', { name: 'Search acoustic tags' });
    await fireEvent.input(search, { target: { value: 'bre' } });
    const option = screen.getByRole('option', { name: 'breath' });
    expect(option).toBeVisible();
    expect(within(option).getByTestId('acoustic-tag-cue-breath-id')).toHaveAttribute(
      'data-color-slot', String(stableColorSlot('breath-id', 5))
    );
    expect(combobox).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', option.id);
    await fireEvent.keyDown(search, { key: 'Enter' });

    expect(onchange).toHaveBeenCalledWith(['breath-id']);
  });

  it('keeps changed selections in project order and marks options without relying on color', async () => {
    const onchange = vi.fn();
    render(AcousticTagSelect, { tags, selectedIds: ['laugh-id'], onchange });

    await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
    const quiet = screen.getByRole('option', { name: 'quiet_dialogue' });
    const laugh = screen.getByRole('option', { name: 'laugh' });
    expect(laugh).toHaveAttribute('aria-selected', 'true');
    expect(within(laugh).getByText('\u2713')).toBeInTheDocument();

    await fireEvent.click(quiet);
    expect(onchange).toHaveBeenCalledWith(['quiet-id', 'laugh-id']);
  });

  it('keeps an option color slot stable when its label changes', async () => {
    const view = render(AcousticTagSelect, { tags, selectedIds: [], onchange: vi.fn() });
    await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
    const expectedSlot = String(stableColorSlot('quiet-id', 5));
    expect(within(screen.getByRole('option', { name: 'quiet_dialogue' }))
      .getByTestId('acoustic-tag-cue-quiet-id')).toHaveAttribute('data-color-slot', expectedSlot);

    await view.rerender({
      tags: tags.map((tag) => tag.id === 'quiet-id' ? { ...tag, label: 'room_tone' } : tag),
      selectedIds: [],
      onchange: vi.fn()
    });

    expect(within(screen.getByRole('option', { name: 'room_tone' }))
      .getByTestId('acoustic-tag-cue-quiet-id')).toHaveAttribute('data-color-slot', expectedSlot);
  });

  it('moves the active option with ArrowDown and ArrowUp', async () => {
    render(AcousticTagSelect, { tags, selectedIds: [], onchange: vi.fn() });
    await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
    const search = screen.getByRole('searchbox');

    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'quiet_dialogue' }).id);
    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'breath' }).id);
    await fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'quiet_dialogue' }).id);
  });

  it('scrolls the newly active option into view while navigating an overflowing list', async () => {
    const overflowingTags = Array.from({ length: 20 }, (_, index) => ({
      id: `tag-${index + 1}`,
      label: `tag_${index + 1}`
    }));
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView
    });

    try {
      render(AcousticTagSelect, { tags: overflowingTags, selectedIds: [], onchange: vi.fn() });
      await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
      const search = screen.getByRole('searchbox');

      for (let index = 0; index < 12; index += 1) {
        await fireEvent.keyDown(search, { key: 'ArrowDown' });
      }

      const activeOption = screen.getByRole('option', { name: 'tag_12' });
      expect(search).toHaveAttribute('aria-activedescendant', activeOption.id);
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
        expect(scrollIntoView.mock.instances.at(-1)).toBe(activeOption);
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it('closes with Escape and restores focus to the combobox', async () => {
    render(AcousticTagSelect, { tags, selectedIds: [], onchange: vi.fn() });
    const combobox = screen.getByRole('combobox', { name: 'Acoustic tags' });
    await fireEvent.click(combobox);

    await fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(combobox).toHaveFocus();
  });

  it('closes when clicking outside', async () => {
    render(AcousticTagSelect, { tags, selectedIds: [], onchange: vi.fn() });
    const combobox = screen.getByRole('combobox', { name: 'Acoustic tags' });
    await fireEvent.click(combobox);

    await fireEvent.click(document.body);

    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('renders removable selected chips', async () => {
    const onchange = vi.fn();
    render(AcousticTagSelect, { tags, selectedIds: ['laugh-id', 'quiet-id'], onchange });
    const selected = screen.getByRole('list', { name: 'Selected acoustic tags' });

    expect(within(selected).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('quiet_dialogue'),
      expect.stringContaining('laugh')
    ]);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove quiet_dialogue acoustic tag' }));

    expect(onchange).toHaveBeenCalledWith(['laugh-id']);
  });

  it('prevents opening or changing selections while disabled', async () => {
    const onchange = vi.fn();
    render(AcousticTagSelect, { tags, selectedIds: ['quiet-id'], disabled: true, onchange });
    const combobox = screen.getByRole('combobox', { name: 'Acoustic tags' });

    expect(combobox).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove quiet_dialogue acoustic tag' })).toBeDisabled();
    await fireEvent.click(combobox);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove quiet_dialogue acoustic tag' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onchange).not.toHaveBeenCalled();
  });
});
