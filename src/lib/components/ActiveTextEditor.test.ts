import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import ActiveTextEditor from './ActiveTextEditor.svelte';

function setupStore(): ProjectStore {
  const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
  const project = createProject({
    canonicalPath: 'a.wav', size: 1, modifiedMs: 1,
    durationMs: 1_000, sampleRate: 1_000, channels: 1
  });
  store.open(project);
  store.patchDraft({ startMs: 10, endMs: 20, transcription: 'draft text' });
  return store;
}

describe('ActiveTextEditor', () => {
  it('updates and submits the active transcription', async () => {
    const store = setupStore();
    render(ActiveTextEditor, { store });
    const editor = screen.getByRole('textbox', { name: 'Transcription' });

    expect(screen.getByRole('region', { name: 'Transcription editor' })).toContainElement(editor);
    await fireEvent.input(editor, { target: { value: 'updated text' } });
    expect(get(store).project?.draft.transcription).toBe('updated text');
    await fireEvent.keyDown(editor, { key: 'Enter' });
    expect(get(store).project?.annotations).toHaveLength(1);
  });

  it('lets Shift+Enter insert a line break without submitting', async () => {
    const store = setupStore();
    render(ActiveTextEditor, { store });
    const editor = screen.getByRole('textbox', { name: 'Transcription' });
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });

    editor.dispatchEvent(shiftEnter);
    await fireEvent.input(editor, { target: { value: 'first\nsecond' } });

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(get(store).project?.annotations).toHaveLength(0);
    expect(get(store).project?.draft.transcription).toBe('first\nsecond');
  });

  it('does not submit an IME composition confirmation', async () => {
    const store = setupStore();
    render(ActiveTextEditor, { store });

    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Transcription' }), { key: 'Enter', isComposing: true });

    expect(get(store).project?.annotations).toHaveLength(0);
  });

  it('disables editing and submission when disabled', async () => {
    const store = setupStore();
    render(ActiveTextEditor, { store, disabled: true });
    const editor = screen.getByRole('textbox', { name: 'Transcription' });

    expect(editor).toBeDisabled();
    await fireEvent.input(editor, { target: { value: 'blocked text' } });
    await fireEvent.keyDown(editor, { key: 'Enter' });

    expect(get(store).project?.draft.transcription).toBe('draft text');
    expect(get(store).project?.annotations).toHaveLength(0);
  });
});
