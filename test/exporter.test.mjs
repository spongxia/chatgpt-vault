import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRasterScale,
  cleanDocumentContent,
  planPdfSlices,
  printableConversationMessages,
  safeDownloadName
} from '../public/exporter.js';

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

test('keeps a message card together when it crosses the ideal page edge', () => {
  assert.deepEqual(
    planPdfSlices(2600, 1000, [850, 1450, 2050], {
      protectedRanges: [{ start: 930, end: 1240 }]
    }),
    [
      { start: 0, end: 930 },
      { start: 930, end: 1930 },
      { start: 1930, end: 2600 }
    ]
  );
});

test('does not choose a natural breakpoint inside a protected card', () => {
  assert.deepEqual(
    planPdfSlices(2000, 1000, [800, 1600], {
      protectedRanges: [{ start: 700, end: 900 }],
      minimumUsefulRatio: 0.6
    }),
    [
      { start: 0, end: 700 },
      { start: 700, end: 1600 },
      { start: 1600, end: 2000 }
    ]
  );
});

test('can split oversized protected content using its inner line boundaries', () => {
  assert.deepEqual(
    planPdfSlices(2500, 1000, [800, 1600, 2200], {
      protectedRanges: [{ start: 100, end: 2300 }],
      minimumUsefulRatio: 0.6
    }),
    [
      { start: 0, end: 800 },
      { start: 800, end: 1600 },
      { start: 1600, end: 2500 }
    ]
  );
});

test('creates filesystem-safe visual export names', () => {
  assert.equal(safeDownloadName('  计划/复盘: 2026?  '), '计划-复盘- 2026-');
});

test('removes attachment and citation markers from document content', () => {
  assert.equal(
    cleanDocumentContent('请分析附件。\n\n[图片或附件：sediment://file_123]\n结论。fileciteturn0file0'),
    '请分析附件。\n\n结论。'
  );
});

test('keeps only readable user and assistant content in PDF documents', () => {
  const messages = [
    { role: 'user', content: '请解释这份文件。' },
    { role: 'tool', content: '{"uploaded":"entire-json-payload"}' },
    { role: 'assistant', content: 'import json\nprint(data)', metadata: { is_visually_hidden_from_conversation: true } },
    { role: 'user', content: '[图片或附件：sediment://file_123]' },
    { role: 'assistant', content: '这是整理后的结论。fileciteturn0file0' }
  ];
  assert.deepEqual(
    printableConversationMessages(messages).map(message => [message.role, message.content]),
    [
      ['user', '请解释这份文件。'],
      ['assistant', '这是整理后的结论。']
    ]
  );
});
