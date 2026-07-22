import { deflateRawSync } from 'node:zlib';
import { conversationToMarkdown } from './conversations.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(value) {
  const candidate = new Date(value);
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export function safeArchiveFilename(value, fallback = 'conversation') {
  const cleaned = String(value || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

export function conversationArchiveEntries(conversations, format) {
  if (!['markdown', 'json'].includes(format)) throw new TypeError(`Unsupported archive format: ${format}`);
  const used = new Set();
  return (conversations || []).map((conversation, index) => {
    const base = safeArchiveFilename(conversation.title, `conversation-${index + 1}`);
    let unique = base;
    let suffix = 2;
    while (used.has(unique.toLocaleLowerCase('en'))) {
      unique = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(unique.toLocaleLowerCase('en'));
    return {
      name: `${unique}.${format === 'markdown' ? 'md' : 'json'}`,
      content: format === 'markdown'
        ? conversationToMarkdown(conversation)
        : `${JSON.stringify(conversation, null, 2)}\n`,
      updatedAt: conversation.updatedAt
    };
  });
}

export function createZipArchive(entries) {
  if ((entries || []).length > 0xffff) throw new RangeError('ZIP archive contains too many files');
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries || []) {
    const name = Buffer.from(String(entry.name || ''), 'utf8');
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''), 'utf8');
    const deflated = deflateRawSync(data, { level: 6 });
    const compressed = deflated.length < data.length ? deflated : data;
    const method = compressed === deflated ? 8 : 0;
    const checksum = crc32(data);
    const timestamp = dosTimestamp(entry.updatedAt);
    if (name.length > 0xffff || data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new RangeError('ZIP archive entry is too large');
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE((entries || []).length, 8);
  end.writeUInt16LE((entries || []).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createConversationArchive(conversations, format) {
  return createZipArchive(conversationArchiveEntries(conversations, format));
}
