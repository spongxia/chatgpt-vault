import { getLocale, t } from './i18n.js';

const TOOL_LABELS = {
  file: { titleKey: 'toolFile', icon: 'i-folder' },
  web: { titleKey: 'toolWeb', icon: 'i-search' },
  product: { titleKey: 'toolProduct', icon: 'i-search' },
  code: { titleKey: 'toolCode', icon: 'i-code' },
  image: { titleKey: 'toolImage', icon: 'i-folder' },
  tool: { titleKey: 'toolGeneric', icon: 'i-settings' }
};

const TOOL_CALL_KEYS = new Set([
  'search_query',
  'system1_search_query',
  'image_query',
  'queries',
  'search',
  'open',
  'click',
  'find',
  'screenshot',
  'calculator',
  'finance',
  'weather',
  'sports',
  'time',
  'prompt'
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(value) {
  try {
    const url = new URL(String(value), location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function sourceTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return t('externalLink');
  }
}

function formatSize(length) {
  if (length >= 100000) return t('characters', { count: `${Math.round(length / 1000)}k` });
  if (length >= 10000) return t('characters', { count: `${(length / 1000).toFixed(1)}k` });
  return t('characters', { count: length.toLocaleString(getLocale()) });
}

function extractUrls(content) {
  const sources = [];
  const seen = new Set();
  const markdownPattern = /\[([^\]\n]{1,240})\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = markdownPattern.exec(content)) !== null) {
    if (/[{}]/.test(match[2])) continue;
    const url = safeHref(match[2]);
    if (!url || /[{}]/.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: match[1].trim(), url, type: 'web' });
  }
  const rawPattern = /https?:\/\/[^\s<>"')\]]+/g;
  while ((match = rawPattern.exec(content)) !== null) {
    if (/[{}]/.test(match[0])) continue;
    const url = safeHref(match[0].replace(/[.,;:!?]+$/, ''));
    if (!url || /[{}]/.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: sourceTitleFromUrl(url), url, type: 'web' });
  }
  return sources;
}

function toolCallObject(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      && Object.keys(parsed).some(key => TOOL_CALL_KEYS.has(key))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function messageRecipient(message) {
  return String(
    message?.recipient
    || message?.metadata?.recipient
    || message?.metadata?.recipient_name
    || message?.metadata?.tool_name
    || ''
  ).trim();
}

export function isInternalToolMessage(message, adjacentMessage = null) {
  if (message?.role === 'tool') return true;
  if (message?.role !== 'assistant') return false;

  const recipient = messageRecipient(message);
  if (recipient && !/^(?:all|assistant|user)$/i.test(recipient)) return true;

  const text = String(message?.content || '').trim();
  if (!text) return false;
  if (/^(?:bash\s+-lc|python3?\s+-\s+<<|search\(|open_url\(|computer\.)/i.test(text)) return true;
  if (/^i[^]+$/.test(text)) return true;
  if (toolCallObject(text)) return true;

  const nextIsTool = adjacentMessage?.role === 'tool'
    || Boolean(messageRecipient(adjacentMessage));
  return nextIsTool
    && /^(?:import\s+[\w., ]+|from\s+[\w.]+\s+import\s+|(?:const|let|var)\s+\w+\s*=|plt\.|fig\s*=)/.test(text);
}

function fileNamesFromContent(content) {
  const names = [];
  const patterns = [
    /【\d+†([^†\n]+)†[^】]+】/g,
    /(?:\/mnt\/data\/|Title:\s*)([^\n/]+\.(?:txt|pdf|docx?|xlsx?|csv|html?|md|png|jpe?g|webp))/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1].trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function metadataCitationSources(metadata) {
  const entries = [];
  const seen = new Set();
  function walk(value, depth = 0) {
    if (!value || depth > 5 || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) {
      const rawUrl = value.url || value.href || value.link;
      const url = rawUrl && safeHref(rawUrl);
      const ids = [
        value.id,
        value.ref_id,
        value.refId,
        value.citation_id,
        value.citationId,
        value.source_id
      ].map(item => String(item || '')).filter(item => /^(?:turn|file_)/i.test(item));
      if (url && ids.length) {
        entries.push({
          ids,
          source: {
            title: String(value.title || value.name || value.attribution || sourceTitleFromUrl(url)),
            url,
            type: /file/i.test(ids[0]) ? 'file' : 'web'
          }
        });
      }
      Object.values(value).forEach(child => walk(child, depth + 1));
      return;
    }
    value.forEach(child => walk(child, depth + 1));
  }
  walk(metadata);
  return entries;
}

export function buildCitationIndex(messages) {
  const index = new Map();
  let recentSources = [];
  for (let messageIndex = 0; messageIndex < (messages || []).length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isInternalToolMessage(message, messages[messageIndex + 1])) continue;
    const content = String(message.content || '');
    const urls = extractUrls(content);
    const metadataEntries = metadataCitationSources(message.metadata);
    metadataEntries.forEach(entry => entry.ids.forEach(id => index.set(id, entry.source)));
    if (urls.length) recentSources = urls;
    if (metadataEntries.length) recentSources = metadataEntries.map(entry => entry.source);
    const fileNames = fileNamesFromContent(content);
    const lines = content.split('\n');

    for (const line of lines) {
      const lineReferences = [...line.matchAll(/(cite|filecite)([^]+)/g)]
        .flatMap(match => match[2].split('').filter(Boolean).map(id => ({ id, type: match[1] })));
      if (!lineReferences.length) continue;
      const lineSources = extractUrls(line);
      for (let position = 0; position < lineReferences.length; position += 1) {
        const { id, type } = lineReferences[position];
        if (type === 'filecite') {
          index.set(id, {
            title: fileNames[position] || fileNames[0] || t('uploadedFile'),
            url: '',
            type: 'file'
          });
          continue;
        }
        const source = lineSources[position]
          || lineSources[0]
          || urls[position]
          || urls[0]
          || recentSources[position]
          || recentSources[0];
        if (source) index.set(id, source);
      }
    }

    const allReferences = [...content.matchAll(/(cite|filecite)([^]+)/g)]
      .flatMap(match => match[2].split('').filter(Boolean).map(id => ({ id, type: match[1] })));
    allReferences.forEach(({ id, type }, position) => {
      if (index.has(id)) return;
      if (type === 'filecite') {
        index.set(id, {
          title: fileNames[position] || fileNames[0] || t('uploadedFile'),
          url: '',
          type: 'file'
        });
        return;
      }
      const source = urls[position] || urls[0] || recentSources[position] || recentSources[0];
      index.set(id, source || {
        title: t('sources', { count: 1 }),
        url: '',
        type: 'reference'
      });
    });
  }

  // ChatGPT exports often keep the citation markers on the final assistant
  // message while the actual URLs only appear in earlier tool-call payloads.
  // Walk the whole conversation once more so those markers can inherit the
  // most recent source pool instead of becoming dead, static pills.
  recentSources = [];
  for (let messageIndex = 0; messageIndex < (messages || []).length; messageIndex += 1) {
    const message = messages[messageIndex];
    const content = String(message?.content || '');
    const internal = isInternalToolMessage(message, messages[messageIndex + 1]);
    const messageSources = extractUrls(content);
    const metadataEntries = metadataCitationSources(message?.metadata);
    metadataEntries.forEach(entry => entry.ids.forEach(id => index.set(id, entry.source)));
    if (internal && messageSources.length) recentSources = messageSources;
    if (metadataEntries.length) recentSources = metadataEntries.map(entry => entry.source);
    const references = [...content.matchAll(/(cite|filecite)([^]+)/g)]
      .flatMap(match => match[2].split('').filter(Boolean).map(id => ({ id, type: match[1] })));
    if (!references.length) continue;
    const fileNames = fileNamesFromContent(content);
    references.forEach(({ id, type }, position) => {
      if (index.has(id)) return;
      if (type === 'filecite') {
        index.set(id, {
          title: fileNames[position] || fileNames[0] || t('uploadedFile'),
          url: '',
          type: 'file'
        });
        return;
      }
      const source = messageSources[position]
        || messageSources[0]
        || recentSources[position]
        || recentSources[0];
      index.set(id, source || {
        title: t('sources', { count: 1 }),
        url: '',
        type: 'reference'
      });
    });
  }
  return index;
}

function renderMath(latex, displayMode) {
  const value = String(latex || '').trim();
  if (!value) return '';
  try {
    if (globalThis.katex?.renderToString) {
      return globalThis.katex.renderToString(value, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml'
      });
    }
  } catch {
    // Fall through to a readable escaped representation.
  }
  return `<span class="math-fallback">${escapeHtml(value)}</span>`;
}

function looksLikeInlineMath(value) {
  const text = String(value || '').trim();
  if (!text || /^\d+(?:[.,]\d+)?$/.test(text)) return false;
  return /\\[a-zA-Z]+|[_^{}=<>+\-*/]|[α-ωΑ-Ω]/.test(text);
}

function attachmentName(reference, fallback = t('uploadedFile')) {
  const decoded = decodeURIComponent(String(reference || ''));
  const explicit = decoded.match(/([^/\\]+\.(?:txt|pdf|docx?|xlsx?|csv|html?|md|png|jpe?g|webp|zip))(?=$|[?#])/i);
  return explicit?.[1] || fallback;
}

export function extractAttachmentMarkers(content) {
  const attachments = [];
  let text = String(content || '');
  text = text.replace(/\[(图片或附件|音频附件)：([^\]]+)\]/g, (_, kind, reference) => {
    attachments.push({
      name: attachmentName(reference, kind === '音频附件' ? t('audioAttachment') : t('uploadedFile')),
      reference,
      kind: kind === '音频附件' ? 'audio' : 'file'
    });
    return '';
  });
  text = text.replace(/【\d+†([^†\n]+)†(file_[^】]+)】/g, (_, name, reference) => {
    attachments.push({ name: name.trim(), reference, kind: 'file' });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), attachments };
}

function renderAttachmentCards(attachments) {
  if (!attachments.length) return '';
  return `<div class="attachment-grid">${attachments.map(attachment => `
    <div class="attachment-card">
      <span class="attachment-icon"><svg><use href="#i-folder"></use></svg></span>
      <span class="attachment-copy">
        <strong>${escapeHtml(attachment.name)}</strong>
        <small>${attachment.kind === 'audio' ? escapeHtml(t('audioAttachment')) : escapeHtml(t('chatgptUpload'))}</small>
      </span>
    </div>
  `).join('')}</div>`;
}

function renderLinkCard(url, label) {
  const safe = safeHref(url);
  if (!safe) return `<span class="broken-link">${escapeHtml(label || url)}</span>`;
  let hostname = t('externalLink');
  let path = '';
  try {
    const parsed = new URL(safe);
    hostname = parsed.hostname.replace(/^www\./, '');
    path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
  } catch {
    // Keep fallback labels.
  }
  return `<a class="link-card" href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">
    <span class="link-card-icon">${escapeHtml(hostname.slice(0, 1).toUpperCase())}</span>
    <span class="link-card-copy">
      <strong>${escapeHtml(label || hostname)}</strong>
      <small>${escapeHtml(hostname)}${path ? ` · ${escapeHtml(path.slice(0, 90))}` : ''}</small>
    </span>
    <svg><use href="#i-external"></use></svg>
  </a>`;
}

function renderInline(value, context) {
  const tokens = [];
  const stash = html => {
    const token = `\u0000R${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };
  let source = String(value ?? '');

  source = source.replace(/`([^`\n]+)`/g, (_, code) => (
    stash(`<code>${escapeHtml(code)}</code>`)
  ));
  source = source.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => (
    stash(`<span class="math-display">${renderMath(math, true)}</span>`)
  ));
  source = source.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => (
    stash(`<span class="math-display">${renderMath(math, true)}</span>`)
  ));
  source = source.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => (
    stash(`<span class="math-inline">${renderMath(math, false)}</span>`)
  ));
  source = source.replace(/(^|[^\\$])\$([^$\n]+)\$/g, (match, prefix, math) => (
    looksLikeInlineMath(math)
      ? `${prefix}${stash(`<span class="math-inline">${renderMath(math, false)}</span>`)}`
      : match
  ));
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    if (/^(sandbox|sediment):/i.test(url)) {
      return stash(`<span class="inline-file">
        <svg><use href="#i-folder"></use></svg>
        <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(t('generatedFile'))}</small></span>
      </span>`);
    }
    const safe = safeHref(url);
    return safe
      ? stash(`<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`)
      : escapeHtml(label);
  });

  source = escapeHtml(source);
  source = source.replace(/(cite|filecite)([^]+)/g, (_, type, rawIds) => {
    const ids = rawIds.split('').filter(Boolean);
    const positions = ids.map(id => {
      if (!context.citationIds.includes(id)) context.citationIds.push(id);
      return context.citationIds.indexOf(id) + 1;
    });
    const label = type === 'filecite' ? t('uploadedFile') : positions.join(',');
    return `<button class="citation-pill" data-source-position="${positions[0] || 1}" title="${escapeHtml(t('sources', { count: context.citationIds.length }))}">${escapeHtml(label)}</button>`;
  });
  source = source.replace(/https?:\/\/[^\s<]+/g, rawUrl => {
    const clean = rawUrl.replace(/[.,;:!?]+$/, '');
    const suffix = rawUrl.slice(clean.length);
    const safe = safeHref(clean.replaceAll('&amp;', '&'));
    return safe
      ? `<a class="raw-link" href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${escapeHtml(sourceTitleFromUrl(safe))}</a>${suffix}`
      : rawUrl;
  });
  source = source
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return source.replace(/\u0000R(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function isBlockStart(line, nextLine) {
  const trimmed = String(line || '').trim();
  return !trimmed
    || /^(`{3,}|#{1,5}\s|>\s?|[-*+]\s+|\d+\.\s+)/.test(trimmed)
    || /^([-*_])\1{2,}$/.test(trimmed)
    || (trimmed.includes('|') && nextLine && /^\s*\|?\s*:?-{3,}/.test(nextLine));
}

function renderSources(context, citationIndex, messageIndex) {
  if (!context.citationIds.length) return '';
  const sources = context.citationIds.map((id, index) => {
    const source = citationIndex.get(id) || {
      title: /file/i.test(id) ? t('uploadedFile') : t('sources', { count: 1 }),
      url: '',
      type: /file/i.test(id) ? 'file' : 'reference'
    };
    const number = index + 1;
    if (source.url) {
      return `<a class="source-row" id="source-${messageIndex}-${number}" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">
        <span class="source-number">${number}</span>
        <span class="source-copy"><strong>${escapeHtml(source.title || sourceTitleFromUrl(source.url))}</strong><small>${escapeHtml(sourceTitleFromUrl(source.url))}</small></span>
        <svg><use href="#i-external"></use></svg>
      </a>`;
    }
    return `<div class="source-row static" id="source-${messageIndex}-${number}">
      <span class="source-number">${number}</span>
      <span class="source-copy"><strong>${escapeHtml(source.title)}</strong><small>${escapeHtml(source.type === 'file' ? t('uploadedInConversation') : t('missingUrl'))}</small></span>
    </div>`;
  }).join('');
  return `<details class="sources-panel">
    <summary><svg><use href="#i-external"></use></svg>${escapeHtml(t('sources', { count: context.citationIds.length }))}</summary>
    <div class="sources-list">${sources}</div>
  </details>`;
}

export function renderRichText(content, citationIndex = new Map(), messageIndex = 0) {
  const extracted = extractAttachmentMarkers(content);
  const lines = extracted.text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const context = { citationIds: [] };
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(`{3,})(.*)$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].trim().replace(/[^\w+#.-]/g, '');
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<div class="code-block">
        <div class="code-toolbar"><span>${escapeHtml(language || t('code'))}</span><button data-copy-code><svg><use href="#i-copy"></use></svg>${escapeHtml(t('copy'))}</button></div>
        <pre><code>${escapeHtml(code.join('\n'))}</code></pre>
      </div>`);
      continue;
    }

    if (/^(\\\[|\$\$)/.test(trimmed)) {
      const isBracket = trimmed.startsWith('\\[');
      const close = isBracket ? '\\]' : '$$';
      const math = [];
      let current = trimmed.slice(isBracket ? 2 : 2);
      if (current.endsWith(close)) {
        math.push(current.slice(0, -close.length));
        index += 1;
      } else {
        math.push(current);
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith(close)) {
          math.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          math.push(lines[index].trim().slice(0, -close.length));
          index += 1;
        }
      }
      blocks.push(`<div class="math-block">${renderMath(math.join('\n'), true)}</div>`);
      continue;
    }

    if (trimmed.includes('|') && lines[index + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const headers = splitTableRow(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(`<div class="table-wrap"><table><thead><tr>${headers.map(cell => `<th>${renderInline(cell, context)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell, context)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,5})\s+(.+)$/);
    if (heading) {
      const level = Math.min(5, heading[1].length);
      blocks.push(`<h${level}>${renderInline(heading[2], context)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote>${quote.map(item => renderInline(item, context)).join('<br>')}</blockquote>`);
      continue;
    }

    const firstList = trimmed.match(/^([-*+]|\d+\.)\s+(.+)$/);
    if (firstList) {
      const ordered = /\d+\./.test(firstList[1]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(ordered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(`<${tag}>${items.map(item => `<li>${renderInline(item, context)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (/^https?:\/\/\S+$/.test(trimmed)) {
      blocks.push(renderLinkCard(trimmed, t('openLink')));
      index += 1;
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(item => renderInline(item, context)).join('<br>')}</p>`);
  }

  return {
    html: `${renderAttachmentCards(extracted.attachments)}${blocks.join('')}${renderSources(context, citationIndex, messageIndex)}`,
    attachments: extracted.attachments,
    citationIds: context.citationIds
  };
}

export function classifyToolMessage(content) {
  const text = String(content || '');
  const call = toolCallObject(text);
  if (call) {
    const keys = Object.keys(call);
    if (keys.includes('prompt') || keys.includes('image_query')) return 'image';
    if (keys.includes('queries')) return 'file';
    return 'web';
  }
  if (/filecite|All the files uploaded|File created at|Content source:|\/mnt\/data\/.*\.(?:txt|pdf|docx?|xlsx?|csv|html?|md)/i.test(text)) return 'file';
  if (/product\d+|product_query|Merchants:|Rating:/i.test(text)) return 'product';
  if (/Displaying results|search results|turn\d+search\d+|search quer|^search\(/i.test(text)) return 'web';
  if (/ImageDisplayed|图表已保存|i|\.png\b|\.jpe?g\b|\.webp\b/i.test(text)) return 'image';
  if (/Traceback|ipykernel|bash -lc|UserWarning:|^total \d+|\/tmp\/|^(?:import\s+|from\s+\S+\s+import\s+)/im.test(text)) return 'code';
  return 'tool';
}

function invisibleToolMessage(content) {
  const text = String(content || '').trim();
  return /^All the files uploaded by the user have been fully loaded/i.test(text)
    || /^The file contents provided above are truncated\/partial snippets/i.test(text)
    || /^You have invoked product_query\./i.test(text);
}

function renderToolGroup(messages, startIndex) {
  const visible = messages.filter(message => !invisibleToolMessage(message.content));
  if (!visible.length) return '';
  const categories = visible.map(message => classifyToolMessage(message.content));
  const priority = ['file', 'web', 'product', 'code', 'image', 'tool'];
  const category = priority.find(candidate => categories.includes(candidate)) || 'tool';
  const meta = TOOL_LABELS[category];
  const fileNames = [...new Set(visible.flatMap(message => fileNamesFromContent(String(message.content || ''))))];
  const summaryTitle = category === 'file' && fileNames.length
    ? fileNames.slice(0, 2).join('、')
    : t(meta.titleKey);
  const totalLength = visible.reduce((sum, message) => sum + String(message.content || '').length, 0);
  return `<details class="tool-card ${category}">
    <summary>
      <span class="tool-icon"><svg><use href="#${meta.icon}"></use></svg></span>
      <span class="tool-summary-copy"><strong>${escapeHtml(summaryTitle)}</strong><small>${visible.length > 1 ? `${escapeHtml(t('items', { count: visible.length }))} · ` : ''}${escapeHtml(formatSize(totalLength))}</small></span>
      <span class="tool-chevron"><svg><use href="#i-chevron"></use></svg></span>
    </summary>
    <div class="tool-entries">${visible.map((message, offset) => `
      <section class="tool-entry">
        ${visible.length > 1 ? `<header>${escapeHtml(t(TOOL_LABELS[classifyToolMessage(message.content)].titleKey))} ${offset + 1}</header>` : ''}
        <button class="tool-copy" data-copy-tool><svg><use href="#i-copy"></use></svg>${escapeHtml(t('copy'))}</button>
        <pre>${escapeHtml(String(message.content || ''))}</pre>
      </section>
    `).join('')}</div>
  </details>`;
}

export function renderConversationMessages(conversation) {
  const messages = conversation?.messages || [];
  const citationIndex = buildCitationIndex(messages);
  const output = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isInternalToolMessage(message, messages[index + 1])) {
      const group = [message];
      while (isInternalToolMessage(messages[index + 1], messages[index + 2])) {
        group.push(messages[index + 1]);
        index += 1;
      }
      const toolHtml = renderToolGroup(group, index - group.length + 1);
      if (toolHtml) output.push(toolHtml);
      continue;
    }

    const sender = message.role === 'user'
      ? t('userName')
      : message.role === 'assistant'
        ? 'ChatGPT'
        : message.role;
    const rendered = renderRichText(message.content, citationIndex, index);
    output.push(`
      <section class="message ${escapeHtml(message.role)}" data-message-index="${index}">
        <div class="message-head">
          <span class="message-avatar"><svg><use href="#i-logo"></use></svg></span>
          <strong>${escapeHtml(sender)}</strong>
          <time>${new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</time>
          <button class="icon-btn copy-message" data-copy-index="${index}" aria-label="${escapeHtml(t('copy'))}"><svg><use href="#i-copy"></use></svg></button>
        </div>
        <div class="message-body">${rendered.html}</div>
      </section>
    `);
  }
  return output.join('');
}

export async function handleRichContentClick(event, conversation, notify) {
  const codeButton = event.target.closest('[data-copy-code]');
  if (codeButton) {
    const code = codeButton.closest('.code-block')?.querySelector('code')?.textContent || '';
    await navigator.clipboard.writeText(code);
    notify?.(t('codeCopied'));
    return true;
  }

  const toolButton = event.target.closest('[data-copy-tool]');
  if (toolButton) {
    const content = toolButton.closest('.tool-entry')?.querySelector('pre')?.textContent || '';
    await navigator.clipboard.writeText(content);
    notify?.(t('toolOutputCopied'));
    return true;
  }

  const citationButton = event.target.closest('[data-source-position]');
  if (citationButton) {
    const message = citationButton.closest('.message');
    const panel = message?.querySelector('.sources-panel');
    if (panel) {
      panel.open = true;
      const position = Number(citationButton.dataset.sourcePosition || 1);
      panel.querySelectorAll('.source-row')[position - 1]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    }
    return true;
  }

  const messageButton = event.target.closest('[data-copy-index]');
  if (messageButton) {
    const message = conversation?.messages?.[Number(messageButton.dataset.copyIndex)];
    if (message) {
      await navigator.clipboard.writeText(message.content);
      notify?.(t('messageCopied'));
    }
    return true;
  }
  return false;
}
