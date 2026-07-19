import { screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';

vi.mock('svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('svelte')>();
  return {
    ...actual,
    mount: vi.fn((...args: Parameters<typeof actual.mount>) => {
      expect(document.documentElement.dataset.palette).toBe('ultraviolet-grid');
      return actual.mount(...args);
    })
  };
});

vi.mock('./lib/bridge/lifecycle', () => ({
  tauriLifecycle: {
    onCloseRequested: vi.fn(async () => vi.fn()),
    destroy: vi.fn(async () => undefined)
  }
}));

import { mount } from 'svelte';

describe('main entry point', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete document.documentElement.dataset.palette;
    localStorage.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('mounts the Lightscribe shell into the app target', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.setItem('lightscribe.palette', 'ultraviolet-grid');

    const { default: app } = await import('./main');
    await Promise.resolve(app);

    expect(document.documentElement.dataset.palette).toBe('ultraviolet-grid');
    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(App, {
      target: document.getElementById('app'),
      props: expect.objectContaining({ bridge: expect.any(Object), pickers: expect.any(Object) })
    });
  });
});
