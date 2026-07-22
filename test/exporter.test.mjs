import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRasterScale, planPdfSlices, safeDownloadName } from '../public/exporter.js';

test('keeps long conversation canvases within browser limits', () => {
  for (const height of [50_000, 1_000_000]) {
    const scale = calculateRasterScale(900, height);
    assert.ok(scale > 0);
    assert.ok(900 * scale <= 30000);
    assert.ok(height * scale <= 30000);
    assert.ok(900 * height * scale * scale <= 64_000_000);
  }
});

test('plans PDF pages near message boundaries', () => {
  assert.deepEqual(
    planPdfSlices(3100, 1000, [850, 1750, 2600]),
    [
      { start: 0, end: 850 },
      { start: 850, end: 1750 },
      { start: 1750, end: 2600 },
      { start: 2600, end: 3100 }
    ]
  );
});

test('creates filesystem-safe visual export names', () => {
  assert.equal(safeDownloadName('  计划/复盘: 2026?  '), '计划-复盘- 2026-');
});
