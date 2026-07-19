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

    const fake = readFileSync('src/test/browserFakeBridge.ts', 'utf8');
    expect(fake).toContain('__LIGHTSCRIBE_LAST_EXPORT__');
    expect(fake).not.toMatch(/portableTsv|encodeMultiline|lastTsv/);
  });

  it('commits the literal UTF-8 fixture text without replacement characters', () => {
    const fixture = readFileSync('tests/fixtures/pass-a.annotation.private.tsv', 'utf8');
    expect(fixture).toContain('\t待って\t');
    expect(fixture).toContain('\tはい\t');
    expect(fixture).not.toContain('\uFFFD');
  });

  it('starts the native window at the approved workspace dimensions', () => {
    const configuration = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      app: { windows: Array<{ width?: number; minWidth?: number; height?: number }> };
    };
    const window = configuration.app.windows[0];

    expect(window.width).toBe(1280);
    expect(window.minWidth).toBe(1280);
    expect(window.height).toBe(800);
  });

  it('uses semantic invalid and disabled states for every non-button form control', () => {
    const css = readFileSync('src/app.css', 'utf8');

    for (const token of [
      '--color-invalid:',
      '--color-invalid-surface:',
      '--color-disabled-surface:',
      '--color-disabled-border:',
      '--color-disabled-text:',
      '--color-disabled-accent:'
    ]) expect(css).toContain(token);

    expect(css).toMatch(/\[aria-invalid="true"\]\s*\{[^}]*var\(--color-invalid\)[^}]*var\(--color-invalid-surface\)/s);
    for (const selector of [
      'input:disabled',
      'select:disabled',
      'textarea:disabled',
      'option:disabled',
      'fieldset:disabled',
      'input[type="radio"]:disabled',
      'input[type="range"]:disabled'
    ]) expect(css).toContain(selector);
    expect(css).toContain(':focus-visible');
  });
});
