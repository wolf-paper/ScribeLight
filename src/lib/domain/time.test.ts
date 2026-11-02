import { describe, expect, it } from 'vitest';
import { formatTime, millisecondsToFrame, parseTime } from './time';

describe('time', () => {
  it('formats positions with minutes', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(72_345)).toBe('1:12.345');
    expect(formatTime(725_005)).toBe('12:05.005');
    expect(formatTime(3_725_005)).toBe('1:02:05.005');
  });

  it('parses minutes, hours, and plain seconds and round-trips formatted times', () => {
    expect(parseTime('1:12.345')).toBe(72_345);
    expect(parseTime(' 83.5 ')).toBe(83_500);
    expect(parseTime('1:02:05.005')).toBe(3_725_005);
    expect(parseTime(formatTime(240_000))).toBe(240_000);
    for (const invalid of ['', '-1', '1:', 'a', '1.5:00', '1:2:3:4', '1e3']) expect(parseTime(invalid)).toBeNull();
  });

  it('maps milliseconds to the nearest PCM frame', () => {
    expect(millisecondsToFrame(1, 48_000)).toBe(48);
    expect(millisecondsToFrame(1, 44_100)).toBe(44);
  });
});
