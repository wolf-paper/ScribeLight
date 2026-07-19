export const PALETTE_IDS = [
  'ion-magenta', 'arctic-steel', 'ultraviolet-grid', 'crimson-scope'
] as const;

export type PaletteId = typeof PALETTE_IDS[number];

export const DEFAULT_PALETTE: PaletteId = 'ion-magenta';
export const PALETTE_STORAGE_KEY = 'lightscribe.palette';

export function normalizePalette(value: string | null): PaletteId {
  return PALETTE_IDS.includes(value as PaletteId) ? value as PaletteId : DEFAULT_PALETTE;
}

export function loadPalette(storage: Pick<Storage, 'getItem'>): PaletteId {
  try {
    return normalizePalette(storage.getItem(PALETTE_STORAGE_KEY));
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function applyPalette(value: PaletteId, root: HTMLElement = document.documentElement): void {
  root.dataset.palette = value;
}

export function persistPalette(
  value: PaletteId,
  storage: Pick<Storage, 'setItem'> = localStorage,
  root: HTMLElement = document.documentElement
): void {
  applyPalette(value, root);
  try {
    storage.setItem(PALETTE_STORAGE_KEY, value);
  } catch {
    // Appearance remains usable.
  }
}

export function stableColorSlot(id: string, count: number): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % count;
}
