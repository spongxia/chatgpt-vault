import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationToChatGptExport,
  conversationSummary,
  conversationToMarkdown,
  mergeConversation,
  normalizeChatGptExport,
  normalizeConversation,
  normalizeImportPayload
} from '../lib/conversations.mjs';

const officialConversation = {
  id: 'conversation-1',
  title: '测试对话',
  create_time: 1710000000,
  current_node: 'assistant-node',
  mapping: {
    'user-node': {
      id: 'user-node',
      parent: null,
      message: {
        id: 'user-message',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['请解释一下本地优先。'] },
        create_time: 1710000001
      }
    },
    'assistant-node': {
      id: 'assistant-node',
      parent: 'user-node',
      message: {
        id: 'assistant-message',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['数据首先保存在本机。'] },
        create_time: 1710000002
      }
    }
  }
};

test('normalizes official ChatGPT mapping in the current-node order', () => {
  const conversation = normalizeChatGptExport({ ...officialConversation, is_archived: true });
  assert.equal(conversation.id, 'conversation-1');
  assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(conversation.messages[1].content, '数据首先保存在本机。');
  assert.equal(conversation.source, 'chatgpt-export');
  assert.equal(conversation.remoteArchived, true);
  assert.equal(conversation.archived, false);
});

test('accepts arrays and wrapper payloads', () => {
  const direct = normalizeImportPayload([officialConversation]);
  const wrapped = normalizeImportPayload({ conversations: [officialConversation] });
  assert.equal(direct.length, 1);
  assert.equal(wrapped[0].id, direct[0].id);
});

test('merges an incremental save without losing local metadata', () => {
  const initial = normalizeChatGptExport(officialConversation);
  initial.favorite = true;
  initial.tags = ['项目'];
  const incoming = { ...officialConversation, title: '更新后的标题', mapping: { ...officialConversation.mapping, 'new-node': { id: 'new-node', parent: 'assistant-node', message: { id: 'new-message', author: { role: 'assistant' }, content: { parts: ['补充内容'] }, create_time: 1710000003 } } }, current_node: 'new-node' };
  const merged = mergeConversation(initial, normalizeChatGptExport(incoming));
  assert.equal(merged.favorite, true);
  assert.deepEqual(merged.tags, ['项目']);
  assert.equal(merged.messages.length, 3);
  assert.equal(merged.title, '测试对话');
});

test('replaces an authoritative remote branch instead of retaining stale messages', () => {
  const initial = normalizeChatGptExport(officialConversation);
  const replacement = normalizeChatGptExport({
    ...officialConversation,
    current_node: 'replacement-node',
    mapping: {
      'user-node': officialConversation.mapping['user-node'],
      'replacement-node': {
        id: 'replacement-node',
        parent: 'user-node',
        message: {
          id: 'replacement-message',
          author: { role: 'assistant' },
          content: { parts: ['新的分支回答'] },
          create_time: 1710000010
        }
      }
    }
  });
  const merged = mergeConversation(initial, replacement);
  assert.deepEqual(
    merged.messages.map(message => message.id),
    ['user-message', 'replacement-message']
  );
});

test('renders a portable Markdown export', () => {
  const conversation = normalizeChatGptExport(officialConversation);
  const markdown = conversationToMarkdown(conversation);
  assert.match(markdown, /^# 测试对话/m);
  assert.match(markdown, /### \*\*You\*\*/);
  assert.match(markdown, /### \*\*ChatGPT\*\*/);
});

test('summarizes the visible conversation without exposing tool-call syntax', () => {
  const conversation = normalizeConversation({
    id: 'preview-test',
    title: '预览测试',
    messages: [
      { role: 'user', content: '请查资料' },
      { role: 'assistant', content: '{"open":[{"ref_id":"https://example.com"}]}' },
      { role: 'tool', content: 'Displaying results' },
      { role: 'assistant', content: '结论是 \\(x^2+y^2=1\\)。' }
    ]
  });
  const summary = conversationSummary(conversation);
  assert.equal(summary.messageCount, 4);
  assert.equal(summary.visibleMessageCount, 2);
  assert.match(summary.preview, /\[公式\]/);
  assert.doesNotMatch(summary.preview, /open|Displaying/);
});

test('exports a ChatGPT-compatible conversations.json mapping', () => {
  const normalized = normalizeChatGptExport(officialConversation);
  const exported = conversationToChatGptExport(normalized);
  assert.equal(exported.conversation_id, normalized.id);
  assert.equal(exported.current_node, 'assistant-message');
  assert.equal(exported.mapping['assistant-message'].parent, 'user-message');
  assert.deepEqual(exported.mapping['user-message'].children, ['assistant-message']);
  assert.equal(exported.mapping['assistant-message'].message.content.content_type, 'text');
  assert.deepEqual(exported.mapping['assistant-message'].message.content.parts, ['数据首先保存在本机。']);

  const roundTrip = normalizeChatGptExport(exported);
  assert.deepEqual(
    roundTrip.messages.map(message => [message.id, message.role, message.content]),
    normalized.messages.map(message => [message.id, message.role, message.content])
  );
});
