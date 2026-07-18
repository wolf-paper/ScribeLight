import { describe, expect, it } from 'vitest';
import { formatTime, millisecondsToFrame } from './time';

describe('time', () => {
  it('formats both ruler modes', () => {
    expect(formatTime(72_345, 'seconds')).toBe('72.345');
    expect(formatTime(72_345, 'clock')).toBe('01:12.345');
  });

  it('maps milliseconds to the nearest PCM frame', () => {
    expect(millisecondsToFrame(1, 48_000)).toBe(48);
    expect(millisecondsToFrame(1, 44_100)).toBe(44);
  });
});
