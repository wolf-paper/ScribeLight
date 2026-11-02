import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import type { Annotation } from '../domain/types';
import { ProjectStore } from '../state/projectStore';
import AnnotationEditor from './AnnotationEditor.svelte';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 10_000, sampleRate: 1_000, channels: 1 };

function setup(annotations: Partial<Annotation>[] = []) {
  const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => `event-${Math.random()}`, () => '2026-01-01T00:00:00Z');
  const project = createProject(audio);
  project.annotations = annotations.map((annotation, index) => ({
    ...project.draft,
    id: `a${index + 1}`,
    startMs: 1_000 * (index + 1),
    endMs: 1_000 * (index + 1) + 500,
    transcription: 'うん',
    createdAt: 'x',
    updatedAt: 'x',
    ...annotation
  }));
  store.open(project);
  const handlers = { onsetboundary: vi.fn(), onplayrange: vi.fn(), ondelete: vi.fn() };
  const view = render(AnnotationEditor, {
    store,
    annotationNumber: null,
    annotationCount: annotations.length,
    ...handlers
  });
  return { store, handlers, view };
}

const radio = (group: string, name: string) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });

describe('AnnotationEditor', () => {
  it('saves every edit to an open annotation without an update step', async () => {
    const { store } = setup([{}]);
    store.selectAnnotation('a1');

    await fireEvent.input(await screen.findByRole('textbox', { name: 'Transcription' }), { target: { value: 'はい' } });
    await fireEvent.click(radio('Intelligibility', 'Partly'));
    await fireEvent.click(radio('Confidence', 'Low'));
    await fireEvent.click(radio('Speaker', 'speaker_2'));

    const saved = get(store).project!.annotations[0];
    expect(saved).toMatchObject({
      transcription: 'はい',
      intelligibility: 'partially_intelligible',
      confidence: 'low',
      speakerId: get(store).project!.speakers[1].id
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
  });

  it('adds a new range with Enter in the transcription and then treats it as saved', async () => {
    const { store } = setup();
    const add = screen.getByRole('button', { name: /Add annotation/ });
    expect(screen.getByRole('heading', { name: 'New annotation' })).toBeInTheDocument();
    expect(add).toBeDisabled();

    store.beginDraft({ startMs: 2_000, endMs: 3_250 });
    const transcription = await screen.findByRole('textbox', { name: 'Transcription' });
    expect(add).toBeEnabled();
    expect(screen.getByText('0:02.000 – 0:03.250 · 1.250 s')).toBeInTheDocument();
    await fireEvent.input(transcription, { target: { value: 'line one\nline two' } });
    expect(get(store).project!.draft.transcription).toBe('line one line two');
    await fireEvent.keyDown(transcription, { key: 'Enter' });

    await vi.waitFor(() => expect(get(store).project!.annotations).toHaveLength(1));
    expect(get(store).project!.annotations[0]).toMatchObject({ startMs: 2_000, endMs: 3_250, transcription: 'line one line two' });
    expect(get(store).project!.activeAnnotationId).toBe(get(store).project!.annotations[0].id);
  });

  it('keeps the overlap choice and the overlap tag in step', async () => {
    const { store } = setup([{}]);
    store.selectAnnotation('a1');
    const overlapTag = get(store).project!.acousticTags.find((tag) => tag.label === 'overlap')!;

    await fireEvent.click(await screen.findByRole('radio', { name: 'Yes' }));
    expect(get(store).project!.annotations[0]).toMatchObject({ overlap: 'overlap', acousticTagIds: [overlapTag.id] });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove overlap acoustic tag' }));
    expect(get(store).project!.annotations[0]).toMatchObject({ overlap: 'none', acousticTagIds: [] });
  });

  it('lists what Yamabiko still needs and clears the note once the row is complete', async () => {
    const { store } = setup([{ speakerId: null, intelligibility: null, overlap: null, confidence: null }]);
    store.selectAnnotation('a1');

    const note = await screen.findByRole('note', { name: 'Yamabiko review' });
    for (const message of ['Choose a speaker', 'Choose an intelligibility', 'Choose an overlap value', 'Choose a confidence']) {
      expect(note).toHaveTextContent(message);
    }
    expect(screen.getByRole('radiogroup', { name: 'Speaker' })).toHaveAttribute('aria-invalid', 'true');

    await fireEvent.click(radio('Speaker', 'speaker_1'));
    await fireEvent.click(radio('Intelligibility', 'Intelligible'));
    await fireEvent.click(radio('Overlap', 'No'));
    await fireEvent.click(radio('Confidence', 'High'));

    expect(screen.queryByRole('note', { name: 'Yamabiko review' })).not.toBeInTheDocument();
  });

  it('accepts typed and stepped times in minutes and refuses ranges that do not fit', async () => {
    const { store } = setup([{}]);
    store.selectAnnotation('a1');
    const start = await screen.findByRole('textbox', { name: 'Start time' });
    expect(start).toHaveValue('0:01.000');

    await fireEvent.focus(start);
    await fireEvent.input(start, { target: { value: '0:01.250' } });
    await fireEvent.keyDown(start, { key: 'Enter' });
    expect(get(store).project!.annotations[0]).toMatchObject({ startMs: 1_250, endMs: 1_500 });

    await fireEvent.keyDown(start, { key: 'ArrowUp', shiftKey: true });
    expect(get(store).project!.annotations[0].startMs).toBe(1_350);

    await fireEvent.focus(start);
    await fireEvent.input(start, { target: { value: '2.0' } });
    await fireEvent.blur(start);
    expect(screen.getByRole('alert')).toHaveTextContent('start before the end');
    expect(start).toHaveValue('0:01.350');
    expect(get(store).project!.annotations[0].startMs).toBe(1_350);
  });

  it('gives a typed start on a draft without a range a one-second range to adjust', async () => {
    const { store } = setup();
    const start = screen.getByRole('textbox', { name: 'Start time' });

    await fireEvent.focus(start);
    await fireEvent.input(start, { target: { value: '0:09.5' } });
    await fireEvent.keyDown(start, { key: 'Enter' });

    expect(get(store).project!.activeSelection).toEqual({ startMs: 9_500, endMs: 10_000 });
    expect(screen.getByRole('textbox', { name: 'End time' })).toHaveValue('0:10.000');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats Non-speech as a speaker choice and fixes the labels Yamabiko requires', async () => {
    const { store } = setup([{}]);
    store.selectAnnotation('a1');

    await fireEvent.click(await screen.findByRole('radio', { name: 'Non-speech' }));

    expect(radio('Speaker', 'Non-speech')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Not applicable')).toBeInTheDocument();
    expect(radio('Overlap', 'No')).toBeDisabled();
    expect(get(store).project!.annotations[0]).toMatchObject({
      eventType: 'non_speech', transcription: '', speakerId: null, intelligibility: 'not_applicable', overlap: 'none'
    });

    await fireEvent.click(radio('Speaker', 'speaker_2'));
    expect(get(store).project!.annotations[0]).toMatchObject({
      eventType: 'speech', speakerId: get(store).project!.speakers[1].id, intelligibility: 'highly_intelligible'
    });
  });

  it('hands deletion of the open annotation to the app and starts a new one on request', async () => {
    const { store, handlers } = setup([{}]);
    store.selectAnnotation('a1');

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(handlers.ondelete).toHaveBeenCalledWith('a1');

    await fireEvent.click(screen.getByRole('button', { name: /New annotation/ }));
    expect(get(store).project!.activeAnnotationId).toBeNull();
    expect(screen.getByRole('heading', { name: 'New annotation' })).toBeInTheDocument();
  });
});
