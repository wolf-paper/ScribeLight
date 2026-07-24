import { screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';

let expectedPalette = 'ion-magenta';

vi.mock('svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('svelte')>();
  return {
    ...actual,
    mount: vi.fn((...args: Parameters<typeof actual.mount>) => {
      expect(document.documentElement.dataset.palette).toBe(expectedPalette);
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

import { mount, unmount } from 'svelte';

describe('main entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete document.documentElement.dataset.palette;
    localStorage.clear();
    expectedPalette = 'ion-magenta';
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('mounts the ScribeLight shell into the app target', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.setItem('lightscribe.palette', 'argon-current');
    expectedPalette = 'argon-current';

    const { default: app } = await import('./main');
    const mountedApp = await app;

    expect(document.documentElement.dataset.palette).toBe('argon-current');
    expect(screen.getByRole('heading', { name: 'ScribeLight' })).toBeInTheDocument();
    expect(mount).toHaveBeenCalledWith(App, {
      target: document.getElementById('app'),
      props: expect.objectContaining({ bridge: expect.any(Object), pickers: expect.any(Object) })
    });
    await unmount(mountedApp);
  });

  it('mounts with the default palette when browser storage is unavailable', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    vi.mocked(mount).mockImplementation(() => ({} as ReturnType<typeof mount>));

    const { default: app } = await import('./main');
    await app;

    expect(document.documentElement.dataset.palette).toBe('ion-magenta');
    expect(mount).toHaveBeenCalledWith(expect.any(Function), {
      target: document.getElementById('app'),
      props: expect.objectContaining({ bridge: expect.any(Object), pickers: expect.any(Object) })
    });
  });
});
