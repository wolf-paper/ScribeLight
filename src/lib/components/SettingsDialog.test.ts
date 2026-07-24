import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import SettingsDialog from './SettingsDialog.svelte';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };
let showModal: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  closeDialog = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: closeDialog });
});

afterEach(() => {
  if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

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
    const { unmount } = render(SettingsDialog, props());

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project labels' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '#settings-appearance');
    expect(screen.getByRole('link', { name: 'Project labels' })).toHaveAttribute('href', '#settings-project-labels');
    expect(screen.getByRole('link', { name: 'Export' })).toHaveAttribute('href', '#settings-export');
    expect(screen.getByRole('combobox', { name: 'Palette' })).toHaveValue('ion-magenta');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus());
    expect(showModal).toHaveBeenCalledTimes(1);

    const background = document.body.appendChild(document.createElement('button'));
    background.textContent = 'Background action';
    background.focus();
    await fireEvent.focusIn(background);
    background.remove();
    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus();

    unmount();
    expect(closeDialog).toHaveBeenCalledTimes(1);
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

  it('offers all multiline policies and reports palette and policy changes for a project', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    const handlers = props(store);
    render(SettingsDialog, handlers);

    await fireEvent.change(screen.getByRole('combobox', { name: 'Palette' }), {
      target: { value: 'sodium-vapor' }
    });
    const policy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(policy).toHaveTextContent('Escape line breaks as \\n');
    expect(policy).toHaveTextContent('Replace line breaks with spaces');
    expect(policy).toHaveTextContent('Preserve line breaks in quoted fields');
    await fireEvent.change(policy, { target: { value: 'quoted' } });

    expect(handlers.onpalette).toHaveBeenCalledWith('sodium-vapor');
    expect(handlers.onpolicy).toHaveBeenCalledWith('quoted');
  });

  it('keeps Appearance usable while disabling Export without a project', async () => {
    const handlers = props();
    render(SettingsDialog, handlers);

    const policy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(policy).toBeDisabled();
    expect(screen.getByText('Open a project to configure export.')).toBeInTheDocument();
    await fireEvent.change(policy, { target: { value: 'quoted' } });
    expect(handlers.onpolicy).not.toHaveBeenCalled();

    const palette = screen.getByRole('combobox', { name: 'Palette' });
    expect(palette).toBeEnabled();
    await fireEvent.change(palette, { target: { value: 'sodium-vapor' } });
    expect(handlers.onpalette).toHaveBeenCalledWith('sodium-vapor');
  });

  it('closes from Escape and the close button', async () => {
    const handlers = props();
    render(SettingsDialog, handlers);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(handlers.onclose).toHaveBeenCalledTimes(3);
  });
});
