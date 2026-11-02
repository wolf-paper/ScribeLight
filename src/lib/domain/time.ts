/** Formats a position as `m:ss.mmm` (`h:mm:ss.mmm` past an hour). */
export function formatTime(milliseconds: number): string {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = ((safe % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Formats a length as seconds with milliseconds, e.g. `1.726 s`. */
export function formatDuration(milliseconds: number): string {
  return `${(Math.max(0, Math.round(milliseconds)) / 1000).toFixed(3)} s`;
}

/**
 * Parses `m:ss.mmm`, `h:mm:ss.mmm`, or plain seconds (`83.456`) into whole milliseconds.
 * Returns null for anything else, including negative or non-finite values.
 */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  if (parts.slice(0, -1).some((part) => part.includes('.'))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

export function millisecondsToFrame(milliseconds: number, sampleRate: number): number {
  if (!Number.isFinite(milliseconds) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('milliseconds and sampleRate must be finite; sampleRate must be positive');
  }
  return Math.round((milliseconds * sampleRate) / 1000);
}
