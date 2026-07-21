import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AnnotationTable, { type AnnotationRow } from './AnnotationTable.svelte';

const annotations: AnnotationRow[] = [
  { id: 'later', startMs: 12_000, endMs: 15_000, speakerId: 'sp-2', speaker: 'Bea', transcription: 'Later note', tags: [], intelligibility: 'not_applicable' },
  { id: 'first', startMs: 10, endMs: 40, speakerId: 'sp-1', speaker: 'Alex', transcription: 'First note', tags: [{ id: 'noise', label: 'Noise' }], intelligibility: 'highly_intelligible' },
  { id: 'overlap', startMs: 20, endMs: 60, speakerId: 'sp-3', speaker: 'Cam', transcription: 'Overlapping note', tags: [{ id: 'breath', label: 'Breath' }], intelligibility: 'partially_intelligible' },
  { id: 'four', startMs: 3_000, endMs: 3_300, speakerId: 'sp-4', speaker: 'Dee', transcription: 'Fourth note', tags: [], intelligibility: 'unintelligible' },
  { id: 'five', startMs: 4_000, endMs: 4_200, speakerId: null, speaker: 'Unknown speaker', transcription: '', tags: [], intelligibility: 'highly_intelligible' },
  { id: 'six', startMs: 5_000, endMs: 5_200, speakerId: 'sp-1', speaker: 'Alex', transcription: 'Sixth note', tags: [], intelligibility: 'partially_intelligible' },
  { id: 'seven', startMs: 6_000, endMs: 6_200, speakerId: 'sp-2', speaker: 'Bea', transcription: 'Seventh note', tags: [], intelligibility: 'unintelligible' },
  { id: 'eight', startMs: 7_000, endMs: 7_200, speakerId: 'sp-3', speaker: 'Cam', transcription: 'Eighth note', tags: [], intelligibility: 'not_applicable' },
  { id: 'nine', startMs: 8_000, endMs: 8_200, speakerId: 'sp-4', speaker: 'Dee', transcription: 'Ninth note', tags: [], intelligibility: 'highly_intelligible' },
  { id: 'ten', startMs: 9_000, endMs: 9_200, speakerId: 'sp-1', speaker: 'Alex', transcription: 'Tenth note', tags: [], intelligibility: 'partially_intelligible' },
  { id: 'eleven', startMs: 10_000, endMs: 10_200, speakerId: 'sp-2', speaker: 'Bea', transcription: 'Eleventh note', tags: [], intelligibility: 'unintelligible' },
  { id: 'twelve', startMs: 11_000, endMs: 11_200, speakerId: 'sp-3', speaker: 'Cam', transcription: 'Twelfth note', tags: [], intelligibility: 'not_applicable' }
];

function renderTable({
  activeId = null,
  disabled = false,
  format = 'clock',
  select = vi.fn(),
  remove = vi.fn(),
  preview = vi.fn()
}: {
  activeId?: string | null;
  disabled?: boolean;
  format?: 'clock' | 'seconds';
  select?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  preview?: ReturnType<typeof vi.fn>;
} = {}) {
  const view = render(AnnotationTable, {
    annotations,
    activeId,
    format,
    disabled,
    onselect: select,
    onremove: remove,
    onpreview: preview
  });
  return { view, select, remove, preview };
}

describe('AnnotationTable', () => {
  it('renders a chronological, continuous grid list with its column headers', () => {
    renderTable();

    expect(screen.getByRole('region', { name: 'Saved annotations' })).toBeInTheDocument();
    expect(screen.getByText('Time')).toHaveAttribute('role', 'columnheader');
    expect(screen.getByText('Speaker')).toHaveAttribute('role', 'columnheader');
    expect(screen.getByText('Transcript')).toHaveAttribute('role', 'columnheader');
    expect(screen.getByText('Tags')).toHaveAttribute('role', 'columnheader');
    expect(screen.getByText('Intelligibility')).toHaveAttribute('role', 'columnheader');
    expect(screen.getByText('Action')).toHaveAttribute('role', 'columnheader');

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(12);
    expect(rows.map((row) => row.getAttribute('data-annotation-id'))).toEqual([
      'first', 'overlap', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'later'
    ]);
    expect(rows[0]).toHaveTextContent('00:00.010–00:00.040');
    expect(rows[1]).toHaveTextContent('00:00.020–00:00.060');
    expect(screen.queryByRole('button', { name: /page/i })).not.toBeInTheDocument();
  });

  it('shows readable annotation metadata and retains its scroll viewport through active-row updates', async () => {
    const { view } = renderTable({ activeId: 'first' });
    const viewport = screen.getByTestId('annotation-list-scroll');
    viewport.scrollTop = 180;

    expect(screen.getByText('No transcript')).toBeInTheDocument();
    expect(screen.getByText('Noise')).toHaveAttribute('data-color-slot');
    expect(screen.getByText('Breath')).toHaveAttribute('data-color-slot');
    expect(screen.getByTestId('speaker-rail-first')).toHaveAttribute('data-color-slot');
    expect(screen.getByTestId('speaker-dot-first')).toHaveAttribute('data-color-slot');
    expect(screen.getAllByText('Highly intelligible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Partially intelligible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unintelligible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not applicable').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Highly intelligible status')[0]).toHaveTextContent('✓ Highly intelligible');
    expect(screen.getAllByLabelText('Partially intelligible status')[0]).toHaveTextContent('◒ Partially intelligible');
    expect(screen.getAllByLabelText('Unintelligible status')[0]).toHaveTextContent('! Unintelligible');
    expect(screen.getAllByLabelText('Not applicable status')[0]).toHaveTextContent('– Not applicable');
    expect(screen.getByRole('row', { name: 'Activate annotation First note' })).toHaveAttribute('aria-current', 'true');

    await view.rerender({
      annotations,
      activeId: 'later',
      format: 'clock',
      onselect: vi.fn(),
      onremove: vi.fn(),
      onpreview: vi.fn()
    });

    expect(screen.getByTestId('annotation-list-scroll')).toBe(viewport);
    expect(viewport.scrollTop).toBe(180);
    expect(screen.getByRole('row', { name: 'Activate annotation Later note' })).toHaveAttribute('aria-current', 'true');
  });

  it('activates rows directly and emits preview intent from pointer and keyboard interaction', async () => {
    const select = vi.fn();
    const preview = vi.fn();
    renderTable({ select, preview });

    const firstRow = screen.getByRole('row', { name: 'Activate annotation First note' });
    await fireEvent.pointerEnter(firstRow);
    expect(preview).toHaveBeenLastCalledWith('first');
    await fireEvent.pointerLeave(firstRow);
    expect(preview).toHaveBeenLastCalledWith(null);

    await fireEvent.focusIn(firstRow);
    expect(preview).toHaveBeenLastCalledWith('first');
    await fireEvent.keyDown(firstRow, { key: 'Enter' });
    await fireEvent.keyDown(firstRow, { key: ' ', code: 'Space' });
    expect(select).toHaveBeenNthCalledWith(1, 'first');
    expect(select).toHaveBeenNthCalledWith(2, 'first');
  });

  it('keeps focused preview intent when a pointer leaves the same row', async () => {
    const preview = vi.fn();
    renderTable({ preview });

    const firstRow = screen.getByRole('row', { name: 'Activate annotation First note' });
    await fireEvent.focusIn(firstRow);
    await fireEvent.pointerEnter(firstRow);
    await fireEvent.pointerLeave(firstRow);

    expect(preview).toHaveBeenLastCalledWith('first');
    expect(preview).not.toHaveBeenLastCalledWith(null);
  });

  it('keeps row activation separate from nested Remove actions', async () => {
    const select = vi.fn();
    const remove = vi.fn();
    renderTable({ select, remove });

    const firstRow = screen.getByRole('row', { name: 'Activate annotation First note' });
    const deleteButton = screen.getByRole('button', { name: 'Remove annotation First note' });
    await fireEvent.click(firstRow);
    await fireEvent.click(deleteButton);
    await fireEvent.keyDown(deleteButton, { key: 'Enter' });

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith('first');
    expect(remove).toHaveBeenCalledWith('first');
    expect(screen.queryByRole('button', { name: 'Edit annotation First note' })).not.toBeInTheDocument();
  });

  it('disables row activation and clears any published preview intent', async () => {
    const select = vi.fn();
    const remove = vi.fn();
    const preview = vi.fn();
    const { view } = renderTable({ select, remove, preview });
    const firstRow = screen.getByRole('row', { name: 'Activate annotation First note' });

    await fireEvent.focusIn(firstRow);
    await view.rerender({
      annotations,
      activeId: null,
      format: 'clock',
      disabled: true,
      onselect: select,
      onremove: remove,
      onpreview: preview
    });

    const disabledRow = screen.getByRole('row', { name: 'Activate annotation First note' });
    expect(disabledRow).toHaveAttribute('aria-disabled', 'true');
    expect(disabledRow).not.toHaveAttribute('tabindex');
    expect(preview).toHaveBeenLastCalledWith(null);
    await fireEvent.pointerEnter(disabledRow);
    await fireEvent.click(disabledRow);
    await fireEvent.keyDown(disabledRow, { key: 'Enter' });
    expect(preview).toHaveBeenLastCalledWith(null);
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove annotation First note' })).toBeDisabled();
  });
});
