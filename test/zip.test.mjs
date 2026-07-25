import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { conversationArchiveEntries, createConversationArchive, createZipArchive, safeArchiveFilename } from '../lib/zip.mjs';

function readZipEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.set(name, content.toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return entries;
}

const conversations = [
  {
    id: 'one', title: '项目/记录', source: 'local', createdAt: '2026-07-20T01:00:00Z', updatedAt: '2026-07-20T01:00:00Z',
    messages: [{ id: 'm1', role: 'user', content: '第一个问题', createdAt: '2026-07-20T01:00:00Z', metadata: {} }]
  },
  {
    id: 'two', title: '项目/记录', source: 'local', createdAt: '2026-07-20T02:00:00Z', updatedAt: '2026-07-20T02:00:00Z',
    messages: [{ id: 'm2', role: 'assistant', content: '第二个回答', createdAt: '2026-07-20T02:00:00Z', metadata: {} }]
  }
];

test('sanitizes archive filenames and keeps duplicate titles unique', () => {
  assert.equal(safeArchiveFilename('项目/记录:*?'), '项目-记录---');
  assert.deepEqual(
    conversationArchiveEntries(conversations, 'markdown').map(entry => entry.name),
    ['项目-记录.md', '项目-记录 (2).md']
  );
});

test('creates readable Markdown and JSON ZIP archives', () => {
  const markdownFiles = readZipEntries(createConversationArchive(conversations, 'markdown'));
  assert.equal(markdownFiles.size, 2);
  assert.match(markdownFiles.get('项目-记录.md'), /^# 项目\/记录/m);
  assert.match(markdownFiles.get('项目-记录 (2).md'), /第二个回答/);

  const jsonFiles = readZipEntries(createConversationArchive(conversations, 'json'));
  assert.equal(JSON.parse(jsonFiles.get('项目-记录.json')).id, 'one');
  assert.equal(JSON.parse(jsonFiles.get('项目-记录 (2).json')).id, 'two');
});

test('creates a valid empty ZIP archive', () => {
  const archive = createZipArchive([]);
  assert.equal(archive.readUInt32LE(0), 0x06054b50);
  assert.equal(archive.readUInt16LE(10), 0);
});
