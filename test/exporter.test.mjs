import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRasterScale,
  cleanDocumentContent,
  findLargestFittingIndex,
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

test('finds the largest DOM fragment that fits on a PDF page', () => {
  assert.equal(findLargestFittingIndex(100, length => length <= 73), 73);
  assert.equal(findLargestFittingIndex(8, () => false), 0);
  assert.equal(findLargestFittingIndex(8, () => true), 8);
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
