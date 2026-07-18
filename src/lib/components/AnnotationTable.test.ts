import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AnnotationTable from './AnnotationTable.svelte';

describe('AnnotationTable', () => {
  it('orders rows by start and preserves overlapping events', async () => {
    const select = vi.fn();
    const remove = vi.fn();
    render(AnnotationTable, {
      annotations: [
        { id: 'later', startMs: 20, endMs: 40, transcription: 'later', speaker: 'speaker_2' },
        { id: 'first', startMs: 10, endMs: 30, transcription: 'first', speaker: 'speaker_1' }
      ], activeId: null, onselect: select, onremove: remove
    });
    const rows = screen.getAllByRole('button', { name: /Edit annotation/ });
    expect(rows[0]).toHaveTextContent('first');
    expect(rows[1]).toHaveTextContent('later');
    await fireEvent.click(rows[1]);
    expect(select).toHaveBeenCalledWith('later');
    await fireEvent.click(screen.getByRole('button', { name: 'Remove annotation first' }));
    expect(remove).toHaveBeenCalledWith('first');
  });

  it('identifies the active row without nesting the remove action', () => {
    render(AnnotationTable, {
      annotations: [{ id: 'first', startMs: 10, endMs: 30, transcription: 'first', speaker: 'speaker_1' }],
      activeId: 'first', onselect: vi.fn(), onremove: vi.fn()
    });
    const edit = screen.getByRole('button', { name: 'Edit annotation first' });
    expect(edit).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Remove annotation first' }).parentElement).not.toBe(edit);
  });
});
