import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import AnnotationDashboard from './AnnotationDashboard.svelte';

function setup(displayFormat: 'seconds' | 'clock' = 'seconds') {
  const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
  const project = createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 });
  project.displayFormat = displayFormat;
  store.open(project);
  store.patchDraft({ startMs: 10, endMs: 20, transcription: '縺・ｓ' });
  render(AnnotationDashboard, { store });
  return store;
}

async function replaceSequentially(input: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(input, { target: { value: '' } });
  let entered = '';
  for (const digit of value) {
    entered += digit;
    await fireEvent.input(input, { target: { value: entered } });
  }
}

describe('AnnotationDashboard', () => {
  it('renders the Selection inspector without label managers', () => {
    setup('clock');

    expect(screen.getByRole('region', { name: 'Selection inspector' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Transcription')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Selection duration')).toHaveTextContent('00:00.010');
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Speaker manager')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Acoustic tag manager')).not.toBeInTheDocument();
  });

  it('renders every canonical intelligibility value with a human-readable label', () => {
    setup();

    expect(screen.getByRole('option', { name: 'Highly intelligible' })).toHaveValue('highly_intelligible');
    expect(screen.getByRole('option', { name: 'Partially intelligible' })).toHaveValue('partially_intelligible');
    expect(screen.getByRole('option', { name: 'Unintelligible' })).toHaveValue('unintelligible');
    expect(screen.getByRole('option', { name: 'Not applicable' })).toHaveValue('not_applicable');
  });

  it('binds integer boundaries and shows the configured time format', async () => {
    const store = setup('clock');
    expect(screen.getByLabelText('Loop start time')).toHaveTextContent('00:00.010');
    expect(screen.getByLabelText('Selection duration')).toHaveTextContent('00:00.010');
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '30' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    expect(screen.getByLabelText('Selection duration')).toHaveTextContent('00:00.020');
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 30 },
      draft: { startMs: 10, endMs: 30 }
    });
  });

  it('keeps sequential boundary input local and publishes one valid pair on completion', async () => {
    const store = setup();
    store.setSelection({ startMs: 10, endMs: 20 });

    const start = screen.getByLabelText('Start milliseconds');
    const end = screen.getByLabelText('End milliseconds');

    await replaceSequentially(start, '30');
    expect(start).toHaveValue(30);
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10, endMs: 20 }
    });
    await fireEvent.change(start);
    expect(start).toHaveValue(30);
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10, endMs: 20 }
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);

    await replaceSequentially(end, '40');
    expect(end).toHaveValue(40);
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10, endMs: 20 }
    });
    await fireEvent.change(end);
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 30, endMs: 40 },
      draft: { startMs: 30, endMs: 40 }
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/loop updates when both boundaries form a valid range/i)).toBeInTheDocument();
  });

  it('exports a validating submission method for raw boundary edits', async () => {
    const saveProject = vi.fn(async () => undefined);
    const store = new ProjectStore({ saveProject }, () => 'submitted-event');
    const project = createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 });
    store.open(project);
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'submitted text' });
    const view = render(AnnotationDashboard, { store });

    await replaceSequentially(screen.getByLabelText('Start milliseconds'), '30');
    view.component.submitDraft();
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);
    expect(get(store).project?.annotations).toHaveLength(0);

    await replaceSequentially(screen.getByLabelText('End milliseconds'), '40');
    view.component.submitDraft();
    await waitFor(() => expect(get(store).project?.annotations).toHaveLength(1));
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 30, endMs: 40 },
      annotations: [expect.objectContaining({ id: 'submitted-event', startMs: 30, endMs: 40 })]
    });
  });

  it('routes Notes plain Enter through raw boundary validation', async () => {
    const store = setup();
    await replaceSequentially(screen.getByLabelText('Start milliseconds'), '30');

    await fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);
    expect(get(store).project?.annotations).toHaveLength(0);

    await replaceSequentially(screen.getByLabelText('End milliseconds'), '40');
    await fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'Enter' });
    await waitFor(() => expect(get(store).project?.annotations).toHaveLength(1));
    expect(get(store).project?.activeSelection).toEqual({ startMs: 30, endMs: 40 });
  });

  it('retains raw boundary edits across unrelated project updates but resets for a new selection', async () => {
    const store = setup();
    store.setSelection({ startMs: 10, endMs: 20 });
    const start = screen.getByLabelText('Start milliseconds');

    await replaceSequentially(start, '30');
    store.patchDraft({ notes: 'unrelated edit' });
    await Promise.resolve();
    expect(start).toHaveValue(30);

    store.setSelection({ startMs: 50, endMs: 60 });
    await Promise.resolve();
    expect(start).toHaveValue(50);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(60);

    await replaceSequentially(start, '70');
    store.setSelection(null);
    await Promise.resolve();
    expect(start).toHaveValue(50);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(60);
  });

  it('normalizes non-speech fields and disables speaker selection', async () => {
    const store = setup();
    await fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'non_speech' } });
    expect(get(store).project!.draft).toMatchObject({ eventType: 'non_speech', transcription: '', intelligibility: 'not_applicable', speakerId: null, overlap: 'none' });
    expect(screen.getByLabelText('Speaker')).toBeDisabled();
  });

  it('uses stable speaker and tag IDs in the draft', async () => {
    const store = setup();
    const project = get(store).project!;
    await fireEvent.change(screen.getByLabelText('Speaker'), { target: { value: project.speakers[1].id } });
    expect(screen.getByTestId('speaker-selection-cue')).toHaveAttribute('data-color-slot');
    await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
    await fireEvent.click(screen.getByRole('option', { name: project.acousticTags[0].label }));
    expect(get(store).project!.draft.speakerId).toBe(project.speakers[1].id);
    expect(get(store).project!.draft.acousticTagIds).toEqual([project.acousticTags[0].id]);
  });

  it('removes the active annotation through the inspector and persists a fresh editor state', async () => {
    const saveProject = vi.fn(async () => undefined);
    const store = new ProjectStore({ saveProject }, () => 'active-event');
    const project = createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 });
    store.open(project);
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'remove me' });
    const view = render(AnnotationDashboard, { store, disabled: false });

    expect(screen.queryByRole('button', { name: 'Remove annotation' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    await waitFor(() => expect(get(store).project!.activeAnnotationId).toBe('active-event'));
    expect(screen.getByRole('button', { name: 'Remove annotation' })).toBeInTheDocument();

    saveProject.mockClear();
    await view.rerender({ store, disabled: true });
    expect(screen.getByRole('button', { name: 'Remove annotation' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove annotation' }));
    expect(saveProject).not.toHaveBeenCalled();

    await view.rerender({ store, disabled: false });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove annotation' }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({
      annotations: [],
      activeAnnotationId: null,
      activeSelection: null
    })));
    expect(get(store).project).toMatchObject({
      annotations: [],
      activeAnnotationId: null,
      activeSelection: null,
      draft: {
        startMs: 0,
        endMs: 0,
        eventType: 'speech',
        transcription: '',
        intelligibility: 'highly_intelligible',
        speakerId: project.speakers[0].id,
        overlap: 'none',
        confidence: 'high',
        acousticTagIds: [],
        notes: ''
      }
    });
    expect(screen.queryByRole('button', { name: 'Remove annotation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
  });

  it('updates, clears, and keeps validation feedback visible', async () => {
    const store = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    expect(await screen.findByRole('button', { name: 'Update annotation' })).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '10' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Update annotation' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(get(store).project!.activeAnnotationId).toBeNull();
  });
});
