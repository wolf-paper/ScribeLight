import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const forbidden = [
  'LIGHTSCRIBE_BROWSER_FAKE_V1',
  '__LIGHTSCRIBE_TEST__',
  'annotation-audio-test.wav',
  'pass-a.annotation.private.tsv',
  '待って',
  'はい',
  'もう一度'
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const bundleFiles = filesUnder('dist').filter((path) => /\.(?:css|html|js|json|map)$/i.test(path));
if (!bundleFiles.length) throw new Error('Production bundle inspection found no generated files');

for (const path of bundleFiles) {
  const contents = readFileSync(path, 'utf8');
  for (const value of forbidden) {
    if (contents.includes(value)) {
      throw new Error(`Production bundle ${path} contains browser-test-only marker ${JSON.stringify(value)}`);
    }
  }
}

console.log(`Production bundle excludes browser fake and fixture markers (${bundleFiles.length} files inspected).`);
