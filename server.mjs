import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  conversationsToChatGptExport,
  conversationSummary,
  mergeConversation,
  normalizeImportPayload,
  storageFilename
} from './lib/conversations.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const SCRIPT_DIR = join(ROOT, 'scripts');
const KATEX_DIR = join(ROOT, 'node_modules', 'katex', 'dist');
const DATA_DIR = resolve(process.env.CHATGPT_VAULT_DATA_DIR || join(ROOT, 'data', 'conversations'));
const PORT = Number(process.env.PORT || 4318);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 80 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.user.js': 'text/javascript; charset=utf-8'
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === 'chatgpt.com'
      || url.hostname.endsWith('.chatgpt.com')
      || url.hostname === 'chat.openai.com'
      || url.hostname === 'chat.com'
      || url.hostname.endsWith('.chat.com');
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-ChatGPT-Vault',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    Vary: 'Origin'
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('导入内容超过 80MB 限制'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 });
  }
}

function fileForConversation(id) {
  return join(DATA_DIR, storageFilename(id));
}

async function loadConversation(id) {
  try {
    return JSON.parse(await readFile(fileForConversation(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveConversation(conversation) {
  await mkdir(DATA_DIR, { recursive: true });
  const target = fileForConversation(conversation.id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(conversation, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

async function readAllConversations() {
  await mkdir(DATA_DIR, { recursive: true });
  const names = (await readdir(DATA_DIR)).filter(name => name.endsWith('.json'));
  return (await Promise.all(names.map(async name => {
    try {
      return JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));
    } catch (error) {
      console.warn(`[ChatGPT Vault] 无法读取 ${name}: ${error.message}`);
      return null;
    }
  })));
}

async function listConversations(query = '') {
  const records = await readAllConversations();
  const needle = String(query).trim().toLocaleLowerCase('zh-CN');
  return records
    .filter(Boolean)
    .filter(conversation => {
      if (!needle) return true;
      const haystack = [
        conversation.title,
        conversation.model,
        ...(conversation.tags || []),
        ...(conversation.messages || []).map(message => message.content)
      ].join('\n').toLocaleLowerCase('zh-CN');
      return haystack.includes(needle);
    })
    .map(conversationSummary)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function syncIndex() {
  const records = await readAllConversations();
  return records
    .filter(Boolean)
    .map(conversation => ({
      id: conversation.id,
      title: conversation.title,
      source: conversation.source,
      updatedAt: conversation.updatedAt,
      importedAt: conversation.importedAt,
      messageCount: conversation.messages?.length || 0,
      archived: Boolean(conversation.archived),
      remoteArchived: Boolean(conversation.remoteArchived)
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function importConversations(payload) {
  const normalized = normalizeImportPayload(payload);
  const result = { imported: 0, updated: 0, skipped: 0, ids: [] };
  for (const incoming of normalized) {
    const existing = await loadConversation(incoming.id);
    const merged = mergeConversation(existing, incoming);
    await saveConversation(merged);
    result[existing ? 'updated' : 'imported'] += 1;
    result.ids.push(merged.id);
  }
  result.skipped = Math.max(0, (Array.isArray(payload) ? payload.length : payload?.conversations?.length || 1) - normalized.length);
  return result;
}

async function updateConversation(id, changes) {
  const existing = await loadConversation(id);
  if (!existing) return null;
  const allowed = {};
  if (typeof changes.title === 'string' && changes.title.trim()) allowed.title = changes.title.trim().slice(0, 500);
  if (Array.isArray(changes.tags)) allowed.tags = [...new Set(changes.tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 30);
  if (typeof changes.favorite === 'boolean') allowed.favorite = changes.favorite;
  if (typeof changes.archived === 'boolean') allowed.archived = changes.archived;
  const updated = { ...existing, ...allowed, importedAt: existing.importedAt };
  await saveConversation(updated);
  return updated;
}

async function serveFile(response, root, requestedPath) {
  const safePath = normalize(requestedPath).replace(new RegExp(`^\\.${sep}`), '');
  const target = resolve(root, safePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return false;
  try {
    const body = await readFile(target);
    const extension = extname(target);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': ['.html', '.js', '.css'].includes(extension) ? 'no-cache' : 'public, max-age=300'
    });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

export function createChatGptVaultServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    const cors = corsHeaders(request);

    try {
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin(request.headers.origin)) return json(response, 403, { error: '不允许的来源' });
        response.writeHead(204, cors);
        return response.end();
      }

      if (url.pathname.startsWith('/api/') && !allowedOrigin(request.headers.origin)) {
        return json(response, 403, { error: '不允许的来源' });
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, 200, { ok: true, version: '1.0.0', dataDirectory: DATA_DIR }, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/conversations') {
        return json(response, 200, { conversations: await listConversations(url.searchParams.get('q') || '') }, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/conversations/export') {
        const conversations = (await readAllConversations()).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return json(response, 200, {
          conversations: conversationsToChatGptExport(conversations),
          format: 'chatgpt-conversations'
        }, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/sync/index') {
        return json(response, 200, { conversations: await syncIndex() }, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/conversations/import') {
        const result = await importConversations(await readBody(request));
        return json(response, 200, result, cors);
      }

      const match = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (request.method === 'GET') {
          const conversation = await loadConversation(id);
          return conversation
            ? json(response, 200, { conversation }, cors)
            : json(response, 404, { error: '没有找到这条对话' }, cors);
        }
        if (request.method === 'PATCH') {
          const conversation = await updateConversation(id, await readBody(request));
          return conversation
            ? json(response, 200, { conversation }, cors)
            : json(response, 404, { error: '没有找到这条对话' }, cors);
        }
        if (request.method === 'DELETE') {
          const conversation = await loadConversation(id);
          if (!conversation) return json(response, 404, { error: '没有找到这条对话' }, cors);
          await unlink(fileForConversation(id));
          return json(response, 200, { deleted: id }, cors);
        }
      }

      if (request.method === 'GET' && url.pathname === '/chatgpt-vault-bridge.user.js') {
        if (await serveFile(response, SCRIPT_DIR, 'chatgpt-vault-bridge.user.js')) return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/vendor/katex/')) {
        const vendorPath = decodeURIComponent(url.pathname.slice('/vendor/katex/'.length));
        if (await serveFile(response, KATEX_DIR, vendorPath)) return;
      }

      if (request.method === 'GET') {
        const publicPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        if (await serveFile(response, PUBLIC_DIR, publicPath)) return;
        if (!extname(publicPath) && await serveFile(response, PUBLIC_DIR, 'index.html')) return;
      }

      json(response, 404, { error: '没有找到这个地址' }, cors);
    } catch (error) {
      console.error('[ChatGPT Vault]', error);
      json(response, error.status || 500, { error: error.status ? error.message : '本地服务发生错误' }, cors);
    }
  });
}

export async function startServer({ port = PORT, host = HOST } = {}) {
  await mkdir(DATA_DIR, { recursive: true });
  const server = createChatGptVaultServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  console.log(`\n  ChatGPT Vault 已启动： http://${host}:${address.port}\n  数据目录：${DATA_DIR}\n`);
  return server;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  startServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
