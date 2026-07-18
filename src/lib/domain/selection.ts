import type { Selection } from './types';

export function normalizeSelection(startMs: number, endMs: number, durationMs: number): Selection | null {
  const start = Math.min(durationMs, Math.max(0, Math.round(startMs)));
  const end = Math.min(durationMs, Math.max(0, Math.round(endMs)));
  if (end <= start) return null;
  return { startMs: start, endMs: end };
}

export function moveSelection(selection: Selection, deltaMs: number, durationMs: number): Selection {
  const width = selection.endMs - selection.startMs;
  const startMs = Math.min(Math.max(0, selection.startMs + Math.round(deltaMs)), durationMs - width);
  return { startMs, endMs: startMs + width };
}
