import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AnnotationList, { type AnnotationRow } from './AnnotationList.svelte';

const row = (id: string, startMs: number, extra: Partial<AnnotationRow> = {}): AnnotationRow => ({
  id, startMs, endMs: startMs + 1_500, speakerId: 'speaker-a', speaker: 'speaker_1', transcription: `text ${id}`,
  tags: [], intelligibility: 'highly_intelligible', problems: [], ...extra
});

function setup(annotations: AnnotationRow[], activeId: string | null = null) {
  const handlers = { onselect: vi.fn(), onpreview: vi.fn(), onreview: vi.fn() };
  render(AnnotationList, { annotations, activeId, ...handlers });
  return handlers;
}

const rows = () => within(screen.getByRole('grid', { name: 'Saved annotations' })).getAllByRole('row').slice(1);

describe('AnnotationList', () => {
  it('lists annotations in time order with minutes, speaker, text, tags, and status', () => {
    setup([
      row('late', 75_250, { tags: [{ id: 't1', label: 'music' }, { id: 't2', label: 'singing' }, { id: 't3', label: 'breath' }] }),
      row('early', 2_000, { speakerId: null, speaker: 'Not set', transcription: '', intelligibility: null, problems: ['Choose a speaker'] })
    ]);

    const [early, late] = rows();
    expect(early).toHaveTextContent('0:02.000');
    expect(early).toHaveTextContent('Not set');
    expect(early).toHaveTextContent('—');
    expect(within(early).getByText('Needs review')).toHaveAttribute('title', 'Choose a speaker');
    expect(late).toHaveTextContent('1:15.250');
    expect(late).toHaveTextContent('1.500 s');
    expect(late).toHaveTextContent('Intelligible');
    expect(within(late).getByText('+1')).toHaveAttribute('title', 'breath');
  });

  it('filters to rows needing review, keeping the open one, and steps through them', async () => {
    const handlers = setup([
      row('a', 1_000, { problems: ['Choose a speaker'] }),
      row('b', 2_000),
      row('c', 3_000, { problems: ['Choose a confidence'] })
    ], 'b');

    await fireEvent.click(screen.getByRole('radio', { name: 'Needs review 2' }));
    expect(rows().map((element) => element.dataset.annotationId)).toEqual(['a', 'b', 'c']);
    await fireEvent.click(screen.getByRole('button', { name: /Next to review/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Previous needing review' }));
    expect(handlers.onreview.mock.calls).toEqual([[1], [-1]]);
  });

  it('hides only the clean rows that are not open when filtering', async () => {
    setup([row('a', 1_000, { problems: ['Choose a speaker'] }), row('b', 2_000)]);
    await fireEvent.click(screen.getByRole('radio', { name: 'Needs review 1' }));
    expect(rows().map((element) => element.dataset.annotationId)).toEqual(['a']);
  });

  it('says the list is ready once nothing needs review', () => {
    setup([row('a', 1_000)]);
    expect(screen.getByText('Ready for Yamabiko')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next to review/ })).not.toBeInTheDocument();
  });

  it('opens rows by click, Enter, and arrow keys, and previews on hover', async () => {
    const handlers = setup([row('a', 1_000), row('b', 2_000)], 'a');
    const [first, second] = rows();

    await fireEvent.click(second);
    await fireEvent.keyDown(first, { key: 'ArrowDown' });
    await fireEvent.keyDown(second, { key: 'ArrowUp' });
    await fireEvent.keyDown(first, { key: 'Enter' });
    expect(handlers.onselect.mock.calls).toEqual([['b'], ['b'], ['a'], ['a']]);

    await fireEvent.pointerEnter(second);
    expect(handlers.onpreview).toHaveBeenLastCalledWith('b');
  });
});
