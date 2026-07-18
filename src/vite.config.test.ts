import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vite server configuration', () => {
  it('uses the port required by the Tauri development URL', () => {
    const config = readFileSync('vite.config.ts', 'utf8');
    expect(config).toMatch(/port:\s*1420/);
  });
});
