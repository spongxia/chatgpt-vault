import { createHash, randomUUID } from 'node:crypto';

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

export function toIso(value, fallback = new Date().toISOString()) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  const milliseconds = typeof numeric === 'number' && numeric < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

function jsonObject(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function looksLikeToolCall(message, nextMessage) {
  if (message?.role === 'tool') return true;
  if (message?.role !== 'assistant') return false;
  const recipient = String(
    message.recipient
    || message.metadata?.recipient
    || message.metadata?.recipient_name
    || message.metadata?.tool_name
    || ''
  );
  if (recipient && !/^(?:all|assistant|user)$/i.test(recipient)) return true;
  const text = String(message.content || '').trim();
  if (/^(?:bash\s+-lc|python3?\s+-\s+<<|search\(|open_url\(|computer\.)/i.test(text)) return true;
  if (/^i[^]+$/.test(text)) return true;
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const object = JSON.parse(text);
      if (object && typeof object === 'object'
        && Object.keys(object).some(key => /^(?:search_query|system1_search_query|image_query|queries|search|open|click|find|screenshot|calculator|finance|weather|sports|time|prompt)$/.test(key))) {
        return true;
      }
    } catch {
      // It is ordinary prose or code, not a serialized tool call.
    }
  }
  return nextMessage?.role === 'tool'
    && /^(?:import\s+[\w., ]+|from\s+[\w.]+\s+import\s+|(?:const|let|var)\s+\w+\s*=|plt\.|fig\s*=)/.test(text);
}

function summaryPreview(messages) {
  const visible = (messages || []).filter((message, index) => !looksLikeToolCall(message, messages[index + 1]));
  const message = [...visible].reverse().find(item => item.content);
  let text = cleanText(message?.content || '');
  text = text
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/\\\[[\s\S]*?\\\]/g, '[公式]')
    .replace(/\\\([\s\S]*?\\\)/g, '[公式]')
    .replace(/\$\$[\s\S]*?\$\$/g, '[公式]')
    .replace(/\$[^$\n]+\$/g, '[公式]')
    .replace(/\[(?:图片或附件|音频附件)：[^\]]+\]/g, '[附件]')
    .replace(/(?:cite|filecite)[^]+/g, '')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/[*_~#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 180);
}

function partToText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (part.asset_pointer || part.image_url) return `[图片或附件：${part.asset_pointer || part.image_url}]`;
  if (part.audio_asset_pointer) return `[音频附件：${part.audio_asset_pointer}]`;
  return '';
}

export function chatGptMessageText(message) {
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content.parts)) return cleanText(content.parts.map(partToText).filter(Boolean).join('\n\n'));
  if (typeof content.text === 'string') return cleanText(content.text);
  if (typeof content.result === 'string') return cleanText(content.result);
  return '';
}

function orderedChatGptNodes(raw) {
  const mapping = raw?.mapping || {};
  const chain = [];
  const visited = new Set();
  let cursor = raw?.current_node;

  while (cursor && mapping[cursor] && !visited.has(cursor)) {
    visited.add(cursor);
    chain.push(mapping[cursor]);
    cursor = mapping[cursor].parent;
  }

  if (chain.length) return chain.reverse();

  return Object.values(mapping)
    .filter(node => node?.message)
    .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
}

export function normalizeChatGptExport(raw) {
  const now = new Date().toISOString();
  const messages = orderedChatGptNodes(raw)
    .map((node, index) => {
      const source = node?.message;
      const role = source?.author?.role;
      const content = chatGptMessageText(source);
      if (!VALID_ROLES.has(role) || !content) return null;
      return {
        id: String(source.id || node.id || `message-${index + 1}`),
        role,
        content,
        createdAt: toIso(source.create_time, now),
        model: source.metadata?.model_slug || source.metadata?.default_model_slug || '',
        status: source.status || 'finished_successfully',
        recipient: cleanText(source.recipient || '').slice(0, 160),
        metadata: jsonObject(source.metadata)
      };
    })
    .filter(Boolean);

  const firstTime = messages[0]?.createdAt || toIso(raw?.create_time, now);
  const lastTime = messages.at(-1)?.createdAt || toIso(raw?.update_time, firstTime);
  return normalizeConversation({
    id: raw?.id || raw?.conversation_id,
    title: raw?.title,
    source: raw?.source || 'chatgpt-export',
    sourceUrl: raw?.id ? `https://chatgpt.com/c/${raw.id}` : '',
    createdAt: toIso(raw?.create_time, firstTime),
    updatedAt: toIso(raw?.update_time, lastTime),
    model: raw?.default_model_slug || messages.find(message => message.model)?.model || '',
    remoteArchived: Boolean(raw?.is_archived),
    messages
  });
}

export function normalizeConversation(input = {}) {
  const now = new Date().toISOString();
  const sourceMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages = sourceMessages
    .map((message, index) => {
      const roleCandidate = String(message?.role || message?.senderType || '').toLowerCase();
      const role = VALID_ROLES.has(roleCandidate)
        ? roleCandidate
        : /^(you|user|human)$/i.test(message?.sender || '') ? 'user' : 'assistant';
      const content = cleanText(message?.content ?? message?.text);
      if (!content) return null;
      return {
        id: String(message?.id || `message-${index + 1}`),
        role,
        content,
        createdAt: toIso(message?.createdAt ?? message?.create_time, input.createdAt || now),
        model: cleanText(message?.model || ''),
        status: cleanText(message?.status || 'finished_successfully'),
        recipient: cleanText(message?.recipient || '').slice(0, 160),
        metadata: jsonObject(message?.metadata)
      };
    })
    .filter(Boolean);

  const stableSeed = `${input.title || ''}\n${messages[0]?.content || ''}\n${input.createdAt || ''}`;
  const generatedId = `local-${createHash('sha256').update(stableSeed || randomUUID()).digest('hex').slice(0, 20)}`;
  const createdAt = toIso(input.createdAt ?? input.create_time, messages[0]?.createdAt || now);
  const updatedAt = toIso(input.updatedAt ?? input.update_time, messages.at(-1)?.createdAt || createdAt);
  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map(cleanText).filter(Boolean))].slice(0, 30);

  return {
    schemaVersion: 1,
    id: cleanText(input.id || generatedId).slice(0, 240),
    title: cleanText(input.title || '未命名对话').slice(0, 500),
    source: cleanText(input.source || input.provider || 'local').slice(0, 80),
    sourceUrl: cleanText(input.sourceUrl || '').slice(0, 2000),
    createdAt,
    updatedAt,
    importedAt: toIso(input.importedAt, now),
    model: cleanText(input.model || messages.find(message => message.model)?.model || '').slice(0, 120),
    tags,
    favorite: Boolean(input.favorite),
    archived: Boolean(input.archived),
    remoteArchived: Boolean(input.remoteArchived),
    messages
  };
}

export function normalizeImportPayload(payload) {
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.conversations) ? payload.conversations : [payload];

  return rawItems
    .filter(item => item && typeof item === 'object')
    .map(item => item.mapping ? normalizeChatGptExport(item) : normalizeConversation(item))
    .filter(conversation => conversation.messages.length > 0);
}

export function mergeConversation(existing, incoming) {
  if (!existing) return normalizeConversation(incoming);
  const normalized = normalizeConversation(incoming);
  const existingMessages = new Map((existing.messages || []).map(message => [message.id, message]));
  for (const message of normalized.messages) existingMessages.set(message.id, message);
  const authoritativeRemote = ['chatgpt-export', 'chatgpt-live'].includes(normalized.source);
  const messages = (authoritativeRemote
    ? normalized.messages
    : [...existingMessages.values()]
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return normalizeConversation({
    ...normalized,
    title: existing.title || normalized.title,
    createdAt: new Date(existing.createdAt) < new Date(normalized.createdAt) ? existing.createdAt : normalized.createdAt,
    updatedAt: new Date(existing.updatedAt) > new Date(normalized.updatedAt) ? existing.updatedAt : normalized.updatedAt,
    importedAt: new Date().toISOString(),
    tags: [...new Set([...(existing.tags || []), ...(normalized.tags || [])])],
    favorite: Boolean(existing.favorite || normalized.favorite),
    archived: Boolean(existing.archived || normalized.archived),
    messages
  });
}

export function conversationSummary(conversation) {
  const messages = conversation.messages || [];
  const visibleMessageCount = messages.filter((message, index) => !looksLikeToolCall(message, messages[index + 1])).length;
  return {
    id: conversation.id,
    title: conversation.title,
    source: conversation.source,
    sourceUrl: conversation.sourceUrl,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    importedAt: conversation.importedAt,
    model: conversation.model,
    tags: conversation.tags || [],
    favorite: Boolean(conversation.favorite),
    archived: Boolean(conversation.archived),
    remoteArchived: Boolean(conversation.remoteArchived),
    messageCount: messages.length,
    visibleMessageCount,
    preview: summaryPreview(messages)
  };
}

function toUnixSeconds(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000;
}

function exportMessageNode(message, parent, children, conversationModel) {
  const metadata = jsonObject(message.metadata);
  if (message.model && !metadata.model_slug) metadata.model_slug = message.model;
  if (!metadata.model_slug && conversationModel) metadata.model_slug = conversationModel;
  return {
    id: message.id,
    message: {
      id: message.id,
      author: {
        role: message.role,
        name: null,
        metadata: {}
      },
      create_time: toUnixSeconds(message.createdAt),
      update_time: null,
      content: {
        content_type: 'text',
        parts: [message.content]
      },
      status: message.status || 'finished_successfully',
      end_turn: message.role === 'assistant' && !message.recipient ? true : null,
      weight: 1,
      metadata,
      recipient: message.recipient || 'all',
      channel: null
    },
    parent,
    children
  };
}

export function conversationToChatGptExport(conversation) {
  const normalized = normalizeConversation(conversation);
  const rootId = `root-${createHash('sha256').update(normalized.id).digest('hex').slice(0, 24)}`;
  const mapping = {
    [rootId]: {
      id: rootId,
      message: null,
      parent: null,
      children: normalized.messages.length ? [normalized.messages[0].id] : []
    }
  };

  normalized.messages.forEach((message, index) => {
    const parent = index === 0 ? rootId : normalized.messages[index - 1].id;
    const children = normalized.messages[index + 1] ? [normalized.messages[index + 1].id] : [];
    mapping[message.id] = exportMessageNode(message, parent, children, normalized.model);
  });

  const currentNode = normalized.messages.at(-1)?.id || rootId;
  return {
    title: normalized.title,
    create_time: toUnixSeconds(normalized.createdAt),
    update_time: toUnixSeconds(normalized.updatedAt),
    mapping,
    moderation_results: [],
    current_node: currentNode,
    plugin_ids: null,
    conversation_id: normalized.id,
    conversation_template_id: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: Boolean(normalized.remoteArchived || normalized.archived),
    is_starred: Boolean(normalized.favorite),
    safe_urls: [],
    blocked_urls: [],
    default_model_slug: normalized.model || null,
    conversation_origin: null,
    voice: null,
    async_status: null,
    disabled_tool_ids: [],
    is_do_not_remember: false,
    memory_scope: 'global_enabled',
    sugar_item_id: null,
    id: normalized.id
  };
}

export function conversationsToChatGptExport(conversations) {
  return (conversations || []).map(conversationToChatGptExport);
}

export function storageFilename(id) {
  return `${createHash('sha256').update(String(id)).digest('hex')}.json`;
}

function markdownRole(role) {
  return role === 'user' ? 'You' : role === 'assistant' ? 'ChatGPT' : role[0].toUpperCase() + role.slice(1);
}

export function conversationToMarkdown(conversation) {
  const metadata = [
    `# ${conversation.title}`,
    '',
    `**Date:** ${conversation.createdAt.slice(0, 10)}`,
    `**Source:** ${conversation.sourceUrl ? `[${conversation.source}](${conversation.sourceUrl})` : conversation.source}`,
    '',
    '---'
  ];
  for (const message of conversation.messages || []) {
    metadata.push('', `### **${markdownRole(message.role)}**`, '', message.content, '', '---');
  }
  return `${metadata.join('\n').trim()}\n`;
}
