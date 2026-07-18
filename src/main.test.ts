import { screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';

vi.mock('svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('svelte')>();
  return { ...actual, mount: vi.fn(actual.mount) };
});

import { mount } from 'svelte';

describe('main entry point', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('mounts the Lightscribe shell into the app target', async () => {
    document.body.innerHTML = '<div id="app"></div>';

    await import('./main');

    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(App, { target: document.getElementById('app') });
  });
});
