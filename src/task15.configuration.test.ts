import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Task 15 release configuration', () => {
  it('runs the approved Vite-aware unit command before checks and native verification', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['build:test']).toBe('vite build --mode test');
    expect(packageJson.scripts['test:e2e']).toBe('playwright test');
    expect(packageJson.scripts.verify).toMatch(/^bun run test && bun run check && bun run build/);
    expect(packageJson.scripts.verify).toContain('cargo fmt --manifest-path src-tauri/Cargo.toml -- --check');
    expect(packageJson.scripts.verify).toContain('cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings');
    expect(packageJson.scripts.verify).toContain('cargo test --manifest-path src-tauri/Cargo.toml');
  });

  it('keeps the browser fake behind the Vite test-mode boundary', () => {
    const entry = readFileSync('src/main.ts', 'utf8');
    expect(entry).toContain("import.meta.env.MODE === 'test'");
    expect(entry).toContain("import('./test/browserFakeBridge').then");
  });

  it('commits the literal UTF-8 fixture text without replacement characters', () => {
    const fixture = readFileSync('tests/fixtures/pass-a.annotation.private.tsv', 'utf8');
    expect(fixture).toContain('\t待って\t');
    expect(fixture).toContain('\tはい\t');
    expect(fixture).not.toContain('\uFFFD');
  });
});
