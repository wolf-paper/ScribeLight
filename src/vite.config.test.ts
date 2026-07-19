import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vite server configuration', () => {
  it('uses the port required by the Tauri development URL', () => {
    const config = readFileSync('vite.config.ts', 'utf8');
    expect(config).toMatch(/port:\s*1420/);
  });

  it('excludes nested worktrees from Vitest discovery', () => {
    const config = readFileSync('vite.config.ts', 'utf8');
    expect(config).toContain("'**/.worktrees/**'");
  });

  it('declares Node types for configuration tests included in type checking', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      devDependencies: Record<string, string>;
    };

    expect(packageJson.devDependencies['@types/node']).toBe('26.1.1');
  });
});
