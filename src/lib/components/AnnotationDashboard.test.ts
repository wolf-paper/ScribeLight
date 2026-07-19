import { fireEvent, render, screen } from '@testing-library/svelte';
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
  it('submits with Enter but not Shift+Enter', async () => {
    const store = setup();
    const editor = screen.getByLabelText('Transcription');
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
    editor.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(get(store).project!.annotations).toHaveLength(0);
    await fireEvent.keyDown(editor, { key: 'Enter' });
    expect(get(store).project!.annotations).toHaveLength(1);
  });

  it('does not submit an IME composition confirmation', async () => {
    const store = setup();
    await fireEvent.keyDown(screen.getByLabelText('Transcription'), { key: 'Enter', isComposing: true });
    expect(get(store).project!.annotations).toHaveLength(0);
  });

  it('binds integer boundaries and shows the configured time format', async () => {
    const store = setup('clock');
    expect(screen.getByLabelText('Loop start time')).toHaveTextContent('00:00.010');
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '30' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
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
    await fireEvent.click(screen.getByLabelText(project.acousticTags[0].label));
    expect(get(store).project!.draft.speakerId).toBe(project.speakers[1].id);
    expect(get(store).project!.draft.acousticTagIds).toEqual([project.acousticTags[0].id]);
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
