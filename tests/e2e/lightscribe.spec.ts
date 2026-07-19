import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../../src/lib/domain/types';

const fixtureUrl = (story: string, reset = false) =>
  `/?fixture=annotation-audio-test.wav&case=${encodeURIComponent(story)}${reset ? '&reset=1' : ''}`;

async function openFixture(page: Page, story: string, reset = true): Promise<void> {
  await page.goto(fixtureUrl(story, reset));
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__?: { marker: string };
    }
  ).__LIGHTSCRIBE_TEST__?.marker)).toBe('LIGHTSCRIBE_BROWSER_FAKE_V1');
  await page.getByRole('button', { name: 'Open audio' }).click();
  await expect(page.getByLabel('Audio waveform')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeEnabled();
}

async function timelineMetrics(page: Page, pointerX: number) {
  return page.getByTestId('timeline-viewport').evaluate((viewport, x) => {
    const content = viewport.querySelector<HTMLElement>('[data-testid="timeline-content"]');
    if (!content) throw new Error('timeline content is missing');
    const width = content.getBoundingClientRect().width;
    return {
      width,
      scrollLeft: viewport.scrollLeft,
      anchorMs: (viewport.scrollLeft + x) / width * 10_000
    };
  }, pointerX);
}

test.use({ viewport: { width: 1280, height: 800 } });

test('runs the complete overlapping annotation, zoom, loop, rename, and UTF-8 export story', async ({ page }) => {
  await openFixture(page, 'complete-story');

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByText('Ctrl + wheel to zoom')).toBeVisible();

  const layers = await page.getByTestId('timeline-content').locator('[data-timeline-layer]').evaluateAll(
    (elements) => elements.map((element) => element.getAttribute('data-timeline-layer'))
  );
  expect(layers).toEqual(['top-ruler', 'loop-selection', 'waveform', 'bottom-ruler']);

  const pointerX = 360;
  const viewport = page.getByTestId('timeline-viewport');
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error('timeline viewport has no layout bounds');
  const beforeZoom = await timelineMetrics(page, pointerX);
  await viewport.dispatchEvent('wheel', {
    ctrlKey: true,
    deltaY: -100,
    clientX: viewportBounds.x + pointerX
  });
  await expect.poll(async () => (await timelineMetrics(page, pointerX)).width).toBeGreaterThan(beforeZoom.width);
  const zoomedIn = await timelineMetrics(page, pointerX);
  expect(zoomedIn.anchorMs).toBeCloseTo(beforeZoom.anchorMs, 0);
  await viewport.dispatchEvent('wheel', {
    ctrlKey: true,
    deltaY: 100,
    clientX: viewportBounds.x + pointerX
  });
  await expect.poll(async () => (await timelineMetrics(page, pointerX)).width).toBeLessThan(zoomedIn.width);
  const zoomedOut = await timelineMetrics(page, pointerX);
  expect(zoomedOut.anchorMs).toBeCloseTo(beforeZoom.anchorMs, 0);

  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { snapshot: { positionMs: number } };
    }
  ).__LIGHTSCRIBE_TEST__.snapshot.positionMs)).toBe(1_000);
  await page.keyboard.press('o');
  await expect(page.getByLabel('Start milliseconds')).toHaveValue('0');
  await expect(page.getByLabel('End milliseconds')).toHaveValue('1000');
  await expect(page.getByRole('button', { name: 'Move loop selection' })).toBeVisible();
  await page.getByRole('button', { name: 'Loop off' }).click();
  await expect(page.getByRole('button', { name: 'Loop on' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { nativeCalls: Array<{ command: string; selection?: { startMs: number; endMs: number } }> };
    }
  ).__LIGHTSCRIBE_TEST__.nativeCalls)).toContainEqual({
    command: 'set_loop', selection: { startMs: 0, endMs: 1_000 }
  });

  await page.getByRole('button', { name: 'Import TSV' }).click();
  const annotations = page.getByLabel('Saved annotations');
  await expect(annotations).toContainText('待って');
  await expect(annotations).toContainText('はい');
  await expect(annotations.locator('.annotation-row')).toHaveCount(10);
  const annotationScroll = page.getByTestId('annotation-list-scroll');
  await expect(annotationScroll).toHaveCSS('overflow-y', 'auto');
  const scrollMetrics = await annotationScroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  const changedScrollTop = await annotationScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(changedScrollTop).toBeGreaterThan(0);
  await expect(annotations.getByRole('button', { name: /page/i })).toHaveCount(0);

  const seededRows = annotations.getByRole('button', { name: /Remove annotation Scroll seed/ });
  await expect(seededRows).toHaveCount(8);
  for (let remaining = 8; remaining > 0; remaining -= 1) {
    await seededRows.first().click();
    await expect(seededRows).toHaveCount(remaining - 1);
  }
  await expect(annotations.locator('.annotation-row')).toHaveCount(2);

  await annotations.locator('.annotation-row').first().getByRole('button', { name: /Edit annotation/ }).click();
  await expect(page.getByLabel('Start milliseconds')).toHaveValue('1000');
  await expect(page.getByLabel('End milliseconds')).toHaveValue('2000');
  const selectedTranscription = page.getByLabel('Transcription');
  const originalTranscription = await selectedTranscription.inputValue();
  expect(originalTranscription).not.toBe('');
  await expect(page.getByRole('button', { name: 'Update annotation' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Acoustic tags' }).click();
  await page.getByRole('option', { name: 'breath' }).click();
  await expect(page.getByRole('button', { name: 'Remove breath acoustic tag' })).toBeVisible();
  await selectedTranscription.fill('Selected annotation updated');
  await selectedTranscription.press('Enter');
  await expect(annotations.locator('.annotation-row')).toHaveCount(2);
  await expect(annotations).toContainText('Selected annotation updated');
  await selectedTranscription.fill(originalTranscription);
  await page.getByRole('button', { name: 'Remove breath acoustic tag' }).click();
  await selectedTranscription.press('Enter');
  await page.getByLabel('Start milliseconds').fill('0');
  await page.getByLabel('Start milliseconds').press('Tab');
  await page.getByLabel('End milliseconds').fill('1000');
  await page.getByLabel('End milliseconds').press('Tab');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { snapshot: { loopRange: { startMs: number; endMs: number } | null } };
    }
  ).__LIGHTSCRIBE_TEST__.snapshot.loopRange)).toEqual({ startMs: 0, endMs: 1_000 });
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('button', { name: 'Add annotation' })).toBeVisible();

  const startBoundary = page.getByLabel('Start milliseconds');
  const endBoundary = page.getByLabel('End milliseconds');
  const loopCallsBeforeEdit = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { nativeCalls: Array<{ command: string }> };
    }
  ).__LIGHTSCRIBE_TEST__.nativeCalls.filter(({ command }) => command === 'set_loop').length);
  await startBoundary.fill('');
  await startBoundary.pressSequentially('3000');
  await expect(startBoundary).toHaveValue('3000');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { nativeCalls: Array<{ command: string }> };
    }
  ).__LIGHTSCRIBE_TEST__.nativeCalls.filter(({ command }) => command === 'set_loop').length)).toBe(loopCallsBeforeEdit);
  await startBoundary.press('Tab');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { snapshot: { loopRange: { startMs: number; endMs: number } | null } };
    }
  ).__LIGHTSCRIBE_TEST__.snapshot.loopRange)).toEqual({ startMs: 0, endMs: 1_000 });
  await endBoundary.fill('');
  await endBoundary.pressSequentially('4000');
  await expect(endBoundary).toHaveValue('4000');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { nativeCalls: Array<{ command: string }> };
    }
  ).__LIGHTSCRIBE_TEST__.nativeCalls.filter(({ command }) => command === 'set_loop').length)).toBe(loopCallsBeforeEdit);
  await endBoundary.press('Tab');
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: {
        snapshot: { loopRange: { startMs: number; endMs: number } | null };
        nativeCalls: Array<{ command: string; selection?: { startMs: number; endMs: number } }>;
      };
    }
  ).__LIGHTSCRIBE_TEST__.snapshot.loopRange)).toEqual({ startMs: 3_000, endMs: 4_000 });
  const recordedLoops = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_TEST__: { nativeCalls: Array<{ command: string; selection?: { startMs: number; endMs: number } }> };
    }
  ).__LIGHTSCRIBE_TEST__.nativeCalls.filter(({ command }) => command === 'set_loop'));
  expect(recordedLoops.at(-1)).toEqual({
    command: 'set_loop', selection: { startMs: 3_000, endMs: 4_000 }
  });
  expect(recordedLoops).not.toContainEqual({
    command: 'set_loop', selection: { startMs: 3_000, endMs: 1_000 }
  });
  const highlightedRange = await page.getByRole('button', { name: 'Move loop selection' }).evaluate((button) => {
    const selection = button.parentElement;
    const track = selection?.parentElement;
    if (!selection || !track) throw new Error('selection highlight has no geometry');
    const trackBounds = track.getBoundingClientRect();
    const selectionBounds = selection.getBoundingClientRect();
    if (!(trackBounds.width > 0) || !(selectionBounds.width > 0)) {
      throw new Error('selection highlight has invalid geometry');
    }
    const millisecondsPerPixel = 10_000 / trackBounds.width;
    const startMs = (selectionBounds.left - trackBounds.left) * millisecondsPerPixel;
    const endMs = (selectionBounds.right - trackBounds.left) * millisecondsPerPixel;
    return { startMs, endMs, millisecondsPerPixel };
  });
  expect(Math.abs(highlightedRange.startMs - 3_000)).toBeLessThanOrEqual(highlightedRange.millisecondsPerPixel);
  expect(Math.abs(highlightedRange.endMs - 4_000)).toBeLessThanOrEqual(highlightedRange.millisecondsPerPixel);
  const transcription = page.getByLabel('Transcription');
  await transcription.fill('もう一度');
  await transcription.press('Enter');
  await expect(annotations.locator('.annotation-row')).toHaveCount(3);
  await expect(annotations).toContainText('もう一度');

  await transcription.fill('もう一度');
  await transcription.press('Shift+Enter');
  await expect(transcription).toHaveValue('もう一度\n');
  await transcription.fill('もう一度\n続き');
  await transcription.press('Enter');
  await expect(annotations).toContainText('もう一度\n続き');
  await expect(annotations.locator('.annotation-row')).toHaveCount(3);

  await page.getByRole('button', { name: 'Settings' }).click();
  const speaker = page.getByLabel('Rename speaker_1');
  await speaker.fill('narrator');
  await speaker.blur();
  await expect(page.getByLabel('Rename narrator')).toHaveValue('narrator');
  const tag = page.getByLabel('Rename quiet_dialogue');
  await tag.fill('whisper');
  await tag.blur();
  await expect(page.getByLabel('Rename whisper')).toHaveValue('whisper');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', { name: 'Export TSV' }).click();
  await expect(page.getByRole('status', { name: 'Operation status' }))
    .toContainText('Exported 3 annotations');
  const exported = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __LIGHTSCRIBE_LAST_EXPORT__: { path: string; project: Project };
    }
  ).__LIGHTSCRIBE_LAST_EXPORT__);
  expect(exported.path).toBe('lightscribe-export.tsv');

  const project = exported.project;
  expect(project.annotations).toHaveLength(3);
  expect(project.activeSelection).toEqual({ startMs: 3_000, endMs: 4_000 });
  expect(project.speakers.map(({ label }) => label)).toContain('narrator');
  expect(project.acousticTags.map(({ label }) => label)).toContain('whisper');
  const portableAnnotations = project.annotations
    .map((annotation) => ({
      startMs: annotation.startMs,
      endMs: annotation.endMs,
      transcription: annotation.transcription,
      overlap: annotation.overlap,
      speaker: project.speakers.find(({ id }) => id === annotation.speakerId)?.label ?? null,
      tags: annotation.acousticTagIds.map((tagId) =>
        project.acousticTags.find(({ id }) => id === tagId)?.label
      )
    }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  expect(portableAnnotations).toEqual([
    {
      startMs: 1_000,
      endMs: 2_000,
      transcription: '待って',
      overlap: 'overlap',
      speaker: 'narrator',
      tags: ['whisper']
    },
    {
      startMs: 1_500,
      endMs: 2_500,
      transcription: 'はい',
      overlap: 'overlap',
      speaker: 'speaker_2',
      tags: ['breath']
    },
    {
      startMs: 3_000,
      endMs: 4_000,
      transcription: 'もう一度\n続き',
      overlap: 'none',
      speaker: 'narrator',
      tags: []
    }
  ]);
});

test('recovers the saved project after a renderer reopen', async ({ page }) => {
  await openFixture(page, 'recovery');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: /Crimson Scope/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'crimson-scope');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByLabel('Start milliseconds').fill('5000');
  await page.getByLabel('End milliseconds').fill('6000');
  await page.getByLabel('Transcription').fill('再開');
  await page.getByLabel('Transcription').press('Enter');
  await expect(page.getByLabel('Saved annotations')).toContainText('再開');

  await page.goto(fixtureUrl('recovery'));
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'crimson-scope');
  await page.getByRole('button', { name: 'Open audio' }).click();
  await expect(page.getByLabel('Audio waveform')).toBeVisible();
  await expect(page.getByLabel('Saved annotations')).toContainText('再開');
});
