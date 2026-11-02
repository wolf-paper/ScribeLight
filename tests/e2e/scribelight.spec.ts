import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../../src/lib/domain/types';

const fixtureUrl = (story: string, reset = false) =>
  `/?fixture=annotation-audio-test.wav&case=${encodeURIComponent(story)}${reset ? '&reset=1' : ''}`;

async function openFixture(page: Page, story: string, reset = true): Promise<void> {
  await page.goto(fixtureUrl(story, reset));
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __SCRIBELIGHT_TEST__?: { marker: string };
    }
  ).__SCRIBELIGHT_TEST__?.marker)).toBe('SCRIBELIGHT_BROWSER_FAKE_V1');
  await page.getByRole('button', { name: 'Open audio' }).click();
  await expect(page.getByLabel('Audio waveform')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeEnabled();
  await expect(page.getByRole('alert', { name: 'Application error' })).toHaveCount(0);
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  return errors;
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

interface TestApi {
  saveProjectCalls: number;
  savedProject: Project | null;
  snapshot: { positionMs: number; loopRange: { startMs: number; endMs: number } | null };
  nativeCalls: Array<{ command: string; selection?: { startMs: number; endMs: number } }>;
}

function testApi(page: Page): Promise<TestApi> {
  return page.evaluate(() => {
    const api = (globalThis as typeof globalThis & { __SCRIBELIGHT_TEST__: TestApi }).__SCRIBELIGHT_TEST__;
    return {
      saveProjectCalls: api.saveProjectCalls,
      savedProject: api.savedProject,
      snapshot: api.snapshot,
      nativeCalls: api.nativeCalls
    };
  });
}

async function savedTags(page: Page, startMs: number): Promise<string[] | null> {
  const project = (await testApi(page)).savedProject;
  const annotation = project?.annotations.find((item) => item.startMs === startMs);
  if (!project || !annotation) return null;
  return annotation.acousticTagIds.map((id) => project.acousticTags.find((tag) => tag.id === id)?.label ?? id);
}

function workspace(page: Page) {
  const annotations = page.getByRole('grid', { name: 'Saved annotations' });
  return {
    annotations,
    rows: annotations.locator('.annotation-row'),
    start: page.getByRole('textbox', { name: 'Start time' }),
    end: page.getByRole('textbox', { name: 'End time' }),
    transcription: page.getByRole('textbox', { name: 'Transcription' }),
    editorTitle: page.locator('#editor-title'),
    saveState: page.locator('.save-state'),
    loop: page.getByRole('button', { name: /^Loop range/ }),
    radio: (group: string, name: string) =>
      page.getByRole('radiogroup', { name: group }).getByRole('radio', { name, exact: true })
  };
}

test.use({ viewport: { width: 1280, height: 800 } });

test('keeps the visible waveform painted after zooming and scrolling past the first canvas tiles', async ({ page }) => {
  await openFixture(page, 'waveform-zoom-rendering');
  const viewport = page.getByTestId('timeline-viewport');
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error('timeline viewport has no layout bounds');

  for (let index = 0; index < 20; index += 1) {
    const width = await viewport.locator('[data-testid="timeline-content"]').evaluate(
      (content) => content.getBoundingClientRect().width
    );
    if (width > 17_000) break;
    await viewport.dispatchEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      clientX: bounds.x + bounds.width / 2
    });
  }

  await expect.poll(() => viewport.locator('[data-testid="timeline-content"]').evaluate(
    (content) => content.getBoundingClientRect().width
  )).toBeGreaterThan(17_000);
  await viewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
  });

  await expect.poll(() => page.getByLabel('Audio waveform').evaluate((waveform) => {
    const viewport = waveform.closest<HTMLElement>('[data-testid="timeline-viewport"]');
    const renderer = waveform.firstElementChild?.shadowRoot;
    if (!viewport || !renderer) return 0;
    const viewportBounds = viewport.getBoundingClientRect();
    const waveformBounds = waveform.getBoundingClientRect();
    const visibleLeft = Math.max(viewportBounds.left, waveformBounds.left);
    const visibleRight = Math.min(viewportBounds.right, waveformBounds.right);
    const intervals = Array.from(renderer.querySelectorAll<HTMLCanvasElement>('.canvases canvas'))
      .map((canvas) => canvas.getBoundingClientRect())
      .map(({ left, right }) => ({
        left: Math.max(left, visibleLeft),
        right: Math.min(right, visibleRight)
      }))
      .filter(({ left, right }) => right > left)
      .sort((a, b) => a.left - b.left);
    let coveredWidth = 0;
    let coveredThrough = visibleLeft;
    for (const interval of intervals) {
      if (interval.left > coveredThrough) break;
      coveredWidth += Math.max(0, interval.right - Math.max(interval.left, coveredThrough));
      coveredThrough = Math.max(coveredThrough, interval.right);
    }
    return coveredWidth / (visibleRight - visibleLeft);
  }), { timeout: 2_000 }).toBeGreaterThan(0.99);
});

test('marks, imports, autosaves, deletes, loops, and exports a Yamabiko worksheet', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await openFixture(page, 'complete-story');
  const { annotations, rows, start, end, transcription, editorTitle, saveState, loop, radio } = workspace(page);

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const layers = await page.getByTestId('timeline-content').locator('[data-timeline-layer]').evaluateAll(
    (elements) => elements.map((element) => element.getAttribute('data-timeline-layer'))
  );
  expect(layers).toEqual(['ruler', 'loop-selection', 'waveform']);

  const pointerX = 360;
  const viewport = page.getByTestId('timeline-viewport');
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error('timeline viewport has no layout bounds');
  const beforeZoom = await timelineMetrics(page, pointerX);
  await viewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: viewportBounds.x + pointerX });
  await expect.poll(async () => (await timelineMetrics(page, pointerX)).width).toBeGreaterThan(beforeZoom.width);
  const zoomedIn = await timelineMetrics(page, pointerX);
  expect(zoomedIn.anchorMs).toBeCloseTo(beforeZoom.anchorMs, 0);
  await viewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: 100, clientX: viewportBounds.x + pointerX });
  await expect.poll(async () => (await timelineMetrics(page, pointerX)).width).toBeLessThan(zoomedIn.width);
  const zoomedOut = await timelineMetrics(page, pointerX);
  expect(zoomedOut.anchorMs).toBeCloseTo(beforeZoom.anchorMs, 0);

  // Mark a range while listening: I at the playhead, move the playhead, O.
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await testApi(page)).snapshot.positionMs).toBe(2_000);
  await page.keyboard.press('o');
  await expect(start).toHaveValue('0:00.000');
  await expect(end).toHaveValue('0:02.000');
  await expect(editorTitle).toHaveText('New annotation');
  await expect(saveState).toHaveText('Not added yet');
  await expect(page.getByRole('button', { name: 'Move loop selection' })).toBeVisible();
  const waveform = page.getByLabel('Audio waveform');
  await expect(waveform.locator('[part~="regions-container"] [data-scribelight-region="selection"]')).toHaveCount(1);
  const contentWidth = await page.getByTestId('timeline-content').evaluate((content) => content.getBoundingClientRect().width);
  const playheadX = await page.getByTestId('timeline-playhead').evaluate((playhead) => new DOMMatrix(getComputedStyle(playhead).transform).m41);
  expect(Math.abs(playheadX - contentWidth * 0.2)).toBeLessThanOrEqual(1);

  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await testApi(page)).nativeCalls).toContainEqual({
    command: 'set_loop', selection: { startMs: 0, endMs: 2_000 }
  });

  await page.getByRole('button', { name: 'Import TSV' }).click();
  await expect(rows).toHaveCount(10);
  await expect(annotations).toContainText('待って');
  await expect(annotations).toContainText('はい');
  await expect(annotations).toHaveCSS('overflow-y', 'auto');

  // Deleting needs no confirmation and can be undone.
  for (let remaining = 8; remaining > 0; remaining -= 1) {
    await rows.filter({ hasText: 'Scroll seed' }).first().click();
    await expect(editorTitle).toHaveText(/^Annotation \d+ of \d+$/);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rows).toHaveCount(remaining + 1);
  }
  await expect(page.getByRole('status', { name: 'Operation status' })).toHaveText('Deleted the annotation at 0:07.900');
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(3);
  await expect(annotations).toContainText('Scroll seed 8');
  await rows.filter({ hasText: 'Scroll seed 8' }).click();
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(2);

  const listBounds = await annotations.boundingBox();
  const editorBounds = await page.locator('.editor').boundingBox();
  if (!listBounds || !editorBounds) throw new Error('annotation workspace has no layout bounds');
  expect(editorBounds.x).toBeGreaterThanOrEqual(listBounds.x + listBounds.width - 1);

  // Deleting leaves a fresh draft; hovering previews a saved range without changing anything.
  await expect(editorTitle).toHaveText('New annotation');
  const previewRegions = page.locator('[data-scribelight-region="preview"]');
  await expect(page.locator('[data-scribelight-region="annotation"]')).toHaveCount(2);
  await expect(previewRegions).toHaveCount(0);
  const beforeHover = await testApi(page);
  const boundariesBeforeHover = [await start.inputValue(), await end.inputValue()];
  await rows.first().hover();
  await expect(previewRegions).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(await testApi(page)).toEqual(beforeHover);
  expect([await start.inputValue(), await end.inputValue()]).toEqual(boundariesBeforeHover);
  expect(await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute('aria-selected')))).toEqual(['false', 'false']);
  await page.getByLabel('Playback position').hover();
  await expect(previewRegions).toHaveCount(0);

  // A single click on a saved range opens it; at 0:02.300 only the second range is under the pointer.
  const content = await page.getByTestId('timeline-content').boundingBox();
  const waveBounds = await waveform.boundingBox();
  if (!content || !waveBounds) throw new Error('timeline has no layout bounds');
  await page.mouse.click(content.x + content.width * 0.23, waveBounds.y + waveBounds.height / 2);
  await expect(start).toHaveValue('0:01.500');
  await expect(end).toHaveValue('0:02.500');
  await expect(editorTitle).toHaveText('Annotation 2 of 2');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Edits to an open annotation save themselves.
  await transcription.fill('Second annotation updated');
  await radio('Confidence', 'Low').click();
  await expect(rows.nth(1)).toContainText('Second annotation updated');
  await expect(saveState).toHaveText('Saved');
  await expect.poll(async () => (await testApi(page)).savedProject?.annotations
    .find(({ startMs }) => startMs === 1_500)).toMatchObject({ transcription: 'Second annotation updated', confidence: 'low' });
  await expect(page.getByRole('button', { name: /update/i })).toHaveCount(0);

  await page.getByRole('button', { name: /^New annotation/ }).click();
  await expect(editorTitle).toHaveText('New annotation');
  await expect(transcription).toHaveValue('');
  await expect(page.getByLabel('Notes')).toHaveValue('');
  await expect(radio('Speaker', 'speaker_1')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Intelligibility', 'Intelligible')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Overlap', 'No')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Confidence', 'High')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: /^Remove .* acoustic tag$/ })).toHaveCount(0);
  expect(await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute('aria-selected')))).toEqual(['false', 'false']);
  await expect.poll(async () => (await testApi(page)).snapshot.loopRange).toBeNull();
  await expect(loop).toHaveAttribute('aria-pressed', 'false');

  // Tags and the Overlap choice stay in step on the open annotation.
  await rows.first().click();
  await expect(start).toHaveValue('0:01.000');
  await page.getByRole('combobox', { name: 'Acoustic tags' }).click();
  await page.getByRole('option', { name: 'breath' }).click();
  await expect.poll(() => savedTags(page, 1_000)).toEqual(['quiet_dialogue', 'overlap', 'breath']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Acoustic tags' })).toHaveCount(0);
  await expect(editorTitle).toHaveText('Annotation 1 of 2');
  await page.getByRole('button', { name: 'Remove breath acoustic tag' }).click();
  await expect.poll(() => savedTags(page, 1_000)).toEqual(['quiet_dialogue', 'overlap']);
  await radio('Overlap', 'No').click();
  await expect.poll(() => savedTags(page, 1_000)).toEqual(['quiet_dialogue']);
  await radio('Overlap', 'Yes').click();
  await expect.poll(() => savedTags(page, 1_000)).toEqual(['quiet_dialogue', 'overlap']);

  // Type a new range, loop it, and add it with Enter.
  await page.getByRole('button', { name: /^New annotation/ }).click();
  await start.fill('0:03');
  await start.press('Enter');
  await expect(end).toHaveValue('0:04.000');
  await end.fill('4.5');
  await end.press('Tab');
  await expect(end).toHaveValue('0:04.500');
  await loop.click();
  await expect.poll(async () => (await testApi(page)).snapshot.loopRange).toEqual({ startMs: 3_000, endMs: 4_500 });
  const highlightedRange = await page.getByRole('button', { name: 'Move loop selection' }).evaluate((button) => {
    const selection = button.parentElement;
    const track = selection?.parentElement;
    if (!selection || !track) throw new Error('selection highlight has no geometry');
    const trackBounds = track.getBoundingClientRect();
    const selectionBounds = selection.getBoundingClientRect();
    const millisecondsPerPixel = 10_000 / trackBounds.width;
    return {
      startMs: (selectionBounds.left - trackBounds.left) * millisecondsPerPixel,
      endMs: (selectionBounds.right - trackBounds.left) * millisecondsPerPixel,
      millisecondsPerPixel
    };
  });
  expect(Math.abs(highlightedRange.startMs - 3_000)).toBeLessThanOrEqual(highlightedRange.millisecondsPerPixel);
  expect(Math.abs(highlightedRange.endMs - 4_500)).toBeLessThanOrEqual(highlightedRange.millisecondsPerPixel);
  await transcription.fill('もう一度\n続き');
  await expect(transcription).toHaveValue('もう一度 続き');
  await transcription.press('Enter');
  await expect(rows).toHaveCount(3);
  await expect(editorTitle).toHaveText('Annotation 3 of 3');
  await expect(annotations).toContainText('もう一度 続き');
  await expect(page.getByText('Ready for Yamabiko')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  const speaker = page.getByLabel('Rename speaker_1');
  await speaker.fill('speaker_7');
  await speaker.blur();
  await expect(page.getByLabel('Rename speaker_7')).toHaveValue('speaker_7');
  const tag = page.getByLabel('Rename quiet_dialogue');
  await tag.fill('whisper');
  await tag.blur();
  await expect(page.getByLabel('Project labels').getByRole('alert')).toContainText("Acoustic tags must be one of Yamabiko's tags");
  await expect(page.getByLabel('Rename quiet_dialogue')).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', { name: 'Export TSV' }).click();
  await expect(page.getByRole('status', { name: 'Operation status' })).toHaveText('Exported 3 annotations');
  const exported = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __SCRIBELIGHT_LAST_EXPORT__: { path: string; project: Project };
    }
  ).__SCRIBELIGHT_LAST_EXPORT__);
  expect(exported.path).toBe('scribelight-export.tsv');
  const project = exported.project;
  expect(project.activeSelection).toEqual({ startMs: 3_000, endMs: 4_500 });
  expect(project.annotations
    .map((annotation) => ({
      startMs: annotation.startMs,
      endMs: annotation.endMs,
      transcription: annotation.transcription,
      overlap: annotation.overlap,
      confidence: annotation.confidence,
      speaker: project.speakers.find(({ id }) => id === annotation.speakerId)?.label ?? null,
      tags: annotation.acousticTagIds.map((tagId) => project.acousticTags.find(({ id }) => id === tagId)?.label)
    }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)).toEqual([
    { startMs: 1_000, endMs: 2_000, transcription: '待って', overlap: 'overlap', confidence: 'high', speaker: 'speaker_7', tags: ['quiet_dialogue', 'overlap'] },
    { startMs: 1_500, endMs: 2_500, transcription: 'Second annotation updated', overlap: 'overlap', confidence: 'low', speaker: 'speaker_2', tags: ['breath', 'overlap'] },
    { startMs: 3_000, endMs: 4_500, transcription: 'もう一度 続き', overlap: 'none', confidence: 'high', speaker: 'speaker_7', tags: [] }
  ]);
  expect(browserErrors).toEqual([]);
});

test('recovers the saved project after a renderer reopen', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await openFixture(page, 'recovery');
  const { annotations, start, transcription } = workspace(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Palette' }).selectOption('krypton-glow');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'krypton-glow');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await start.fill('0:05');
  await start.press('Enter');
  await transcription.fill('再開');
  await transcription.press('Enter');
  await expect(annotations).toContainText('再開');

  await page.goto(fixtureUrl('recovery'));
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'krypton-glow');
  await page.getByRole('button', { name: 'Open audio' }).click();
  await expect(page.getByLabel('Audio waveform')).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Saved annotations' })).toContainText('再開');
  expect(browserErrors).toEqual([]);
});
