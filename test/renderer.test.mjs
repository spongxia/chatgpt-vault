import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCitationIndex,
  classifyToolMessage,
  extractAttachmentMarkers,
  isInternalToolMessage,
  renderConversationMessages,
  renderRichText
} from '../public/renderer.js';

globalThis.location = { href: 'http://127.0.0.1:4318/' };
globalThis.katex = {
  renderToString(value, options) {
    return `<span data-math="${options.displayMode ? 'display' : 'inline'}">${value}</span>`;
  }
};

test('renders inline and display LaTeX through the math renderer', () => {
  const rendered = renderRichText('行内公式 \\(x^2+y^2=1\\)\n\n\\[\\frac{a}{b}\\]');
  assert.match(rendered.html, /data-math="inline"/);
  assert.match(rendered.html, /data-math="display"/);
  assert.doesNotMatch(rendered.html, /\\\\frac/);
});

test('renders multiline display math inside blockquotes', () => {
  const rendered = renderRichText('> 公式如下：\n> \\[\n> \\frac{a}{b}\n> \\]\n> 说明文字');
  assert.match(rendered.html, /<blockquote>/);
  assert.match(rendered.html, /data-math="display"/);
  assert.doesNotMatch(rendered.html, /\\\\frac/);
});

test('turns uploaded-file markers into compact attachment cards', () => {
  const extracted = extractAttachmentMarkers('请阅读\n\n[图片或附件：sediment://file_abc]');
  assert.equal(extracted.text, '请阅读');
  assert.equal(extracted.attachments.length, 1);
  assert.equal(extracted.attachments[0].name, 'Uploaded file');
  const rendered = renderRichText('请阅读\n\n[图片或附件：sediment://file_abc]');
  assert.match(rendered.html, /attachment-card/);
  assert.doesNotMatch(rendered.html, /sediment:\/\//);
});

test('builds a collapsed citation source index from tool output', () => {
  const index = buildCitationIndex([{
    role: 'tool',
    content: '[官方文档](https://example.com/docs) citeturn1search0'
  }]);
  assert.equal(index.get('turn1search0').url, 'https://example.com/docs');
  const rendered = renderRichText(
    '结论。citeturn1search0',
    index,
    2
  );
  assert.match(rendered.html, /citation-pill/);
  assert.match(rendered.html, /sources-panel/);
  assert.match(rendered.html, /https:\/\/example\.com\/docs/);
});

test('uses preserved ChatGPT citation metadata when content omits URLs', () => {
  const index = buildCitationIndex([{
    role: 'tool',
    content: 'search result',
    metadata: {
      content_references: [{
        type: 'cite',
        id: 'turn9search0',
        title: '官方页面',
        url: 'https://example.com/source'
      }]
    }
  }]);
  assert.equal(index.get('turn9search0').url, 'https://example.com/source');
});

test('does not attach unrelated web URLs to file citations', () => {
  const index = buildCitationIndex([
    {
      role: 'assistant',
      content: '{"open":[{"ref_id":"https://example.com"}]}'
    },
    {
      role: 'tool',
      content: 'Make sure to include fileciteturn2file0.'
    }
  ]);
  assert.equal(index.get('turn2file0').type, 'file');
  assert.equal(index.get('turn2file0').url, '');
});

test('classifies large uploaded text payloads as file tool output', () => {
  assert.equal(
    classifyToolMessage('Make sure to include fileciteturn0file0. /mnt/data/notes.txt'),
    'file'
  );
});

test('folds assistant messages that were actually sent to tools', () => {
  assert.equal(isInternalToolMessage({
    role: 'assistant',
    content: "bash -lc python - <<'PY'\nprint(1)\nPY"
  }), true);
  assert.equal(isInternalToolMessage({
    role: 'assistant',
    content: '{"open":[{"ref_id":"https://example.com"}]}'
  }), true);

  const html = renderConversationMessages({
    messages: [
      { role: 'user', content: '查一下', createdAt: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: '{"open":[{"ref_id":"https://example.com"}]}', createdAt: '2026-01-01T00:00:01Z' },
      { role: 'tool', content: '结果', createdAt: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: '这是结论。', createdAt: '2026-01-01T00:00:03Z' }
    ]
  });
  assert.equal((html.match(/class="message assistant"/g) || []).length, 1);
  assert.equal((html.match(/class="tool-card/g) || []).length, 1);
});

test('adds an edit action to each visible historical message', () => {
  const html = renderConversationMessages({
    messages: [
      { id: 'message-1', role: 'user', content: '原始内容', createdAt: '2026-01-01T00:00:00Z' }
    ]
  });
  assert.match(html, /data-edit-index="0"/);
  assert.match(html, /href="#i-edit"/);
});
