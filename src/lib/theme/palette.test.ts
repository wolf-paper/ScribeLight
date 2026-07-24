import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PALETTE,
  PALETTE_IDS,
  PALETTE_STORAGE_KEY,
  applyPalette,
  loadPalette,
  normalizePalette,
  persistPalette,
  stableColorSlot
} from './palette';

describe('palette preferences', () => {
  it('exposes the approved palettes and falls back to Ion Magenta', () => {
    expect(PALETTE_IDS).toEqual([
      'ion-magenta',
      'neon-ember',
      'mercury-vapor',
      'argon-current',
      'xenon-arc',
      'krypton-glow',
      'sodium-vapor',
      'oxygen-pearl'
    ]);
    expect(DEFAULT_PALETTE).toBe('ion-magenta');
    expect(normalizePalette('arctic-steel')).toBe('ion-magenta');
    expect(normalizePalette('unknown')).toBe('ion-magenta');
    expect(normalizePalette(null)).toBe('ion-magenta');
  });

  it('falls back to the default when stored preferences cannot be read', () => {
    expect(loadPalette({ getItem: () => { throw new Error('denied'); } })).toBe('ion-magenta');
  });

  it('applies a persisted palette when writing storage fails', () => {
    const storage = { setItem: vi.fn(() => { throw new Error('denied'); }) };
    const root = document.documentElement;

    persistPalette('krypton-glow', storage, root);

    expect(root.dataset.palette).toBe('krypton-glow');
    expect(storage.setItem).toHaveBeenCalledWith(PALETTE_STORAGE_KEY, 'krypton-glow');
  });

  it('applies a persisted palette when browser storage is unavailable', () => {
    const root = document.createElement('div');
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });

    expect(() => persistPalette('neon-ember', undefined, root)).not.toThrow();
    expect(root.dataset.palette).toBe('neon-ember');

    vi.restoreAllMocks();
  });

  it('can apply a palette to an explicit root', () => {
    const root = document.createElement('div');

    applyPalette('xenon-arc', root);

    expect(root.dataset.palette).toBe('xenon-arc');
  });

  it('assigns deterministic color slots for a stable ID', () => {
    expect(stableColorSlot('stable-id', 5)).toBe(stableColorSlot('stable-id', 5));
  });
});
