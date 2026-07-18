import type { TimeDisplayFormat } from './types';

export function formatTime(milliseconds: number, format: TimeDisplayFormat): string {
  const safe = Math.max(0, Math.round(milliseconds));
  if (format === 'seconds') return (safe / 1000).toFixed(3);
  const minutes = Math.floor(safe / 60_000);
  const seconds = (safe % 60_000) / 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`;
}

export function millisecondsToFrame(milliseconds: number, sampleRate: number): number {
  if (!Number.isFinite(milliseconds) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('milliseconds and sampleRate must be finite; sampleRate must be positive');
  }
  return Math.round((milliseconds * sampleRate) / 1000);
}
