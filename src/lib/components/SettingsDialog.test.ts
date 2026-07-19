import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import SettingsDialog from './SettingsDialog.svelte';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

function props(store: ProjectStore | null = null) {
  return {
    store,
    palette: 'ion-magenta' as const,
    multilinePolicy: 'escape' as const,
    onpalette: vi.fn(),
    onpolicy: vi.fn(),
    onclose: vi.fn()
  };
}

describe('SettingsDialog', () => {
  it('is an accessible, focused dialog with navigable settings sections', async () => {
    render(SettingsDialog, props());

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project labels' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '#settings-appearance');
    expect(screen.getByRole('link', { name: 'Project labels' })).toHaveAttribute('href', '#settings-project-labels');
    expect(screen.getByRole('link', { name: 'Export' })).toHaveAttribute('href', '#settings-export');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus());
  });

  it('shows project label managers only when a project exists', () => {
    const { unmount } = render(SettingsDialog, props());
    expect(screen.queryByRole('region', { name: 'Speaker manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Acoustic tag manager' })).not.toBeInTheDocument();
    expect(screen.getByText('Open a project to manage labels.')).toBeInTheDocument();
    unmount();

    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    render(SettingsDialog, props(store));
    expect(screen.getByRole('region', { name: 'Speaker manager' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Acoustic tag manager' })).toBeInTheDocument();
  });

  it('offers all multiline policies and reports palette and policy changes', async () => {
    const handlers = props();
    render(SettingsDialog, handlers);

    await fireEvent.click(screen.getByRole('radio', { name: /Arctic Steel/ }));
    const policy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(policy).toHaveTextContent('Escape line breaks as \\n');
    expect(policy).toHaveTextContent('Replace line breaks with spaces');
    expect(policy).toHaveTextContent('Preserve line breaks in quoted fields');
    await fireEvent.change(policy, { target: { value: 'quoted' } });

    expect(handlers.onpalette).toHaveBeenCalledWith('arctic-steel');
    expect(handlers.onpolicy).toHaveBeenCalledWith('quoted');
  });

  it('closes from Escape and the close button', async () => {
    const handlers = props();
    render(SettingsDialog, handlers);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(handlers.onclose).toHaveBeenCalledTimes(2);
  });
});
