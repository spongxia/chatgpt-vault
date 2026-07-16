import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PORT = Number(process.env.PORT || 4318);
const normal = Array.from({ length: 250 }, (_, index) => ({
  id: `remote-${String(index).padStart(3, '0')}`,
  title: `普通会话 ${index}`,
  create_time: 1710000000 + index,
  update_time: 1710001000 + index,
  is_archived: false
}));
const archived = Array.from({ length: 30 }, (_, index) => ({
  id: `archived-${String(index).padStart(3, '0')}`,
  title: `归档会话 ${index}`,
  create_time: 1700000000 + index,
  update_time: 1700001000 + index,
  is_archived: true
}));
const imported = [];

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(JSON.stringify(body));
}

function detail(id) {
  const item = [...normal, ...archived].find(candidate => candidate.id === id);
  if (!item) return null;
  return {
    ...item,
    current_node: 'assistant-node',
    mapping: {
      'user-node': {
        id: 'user-node',
        parent: null,
        message: {
          id: `${id}-user`,
          author: { role: 'user' },
          content: { parts: [`${item.title}的问题`] },
          create_time: item.create_time
        }
      },
      'assistant-node': {
        id: 'assistant-node',
        parent: 'user-node',
        message: {
          id: `${id}-assistant`,
          author: { role: 'assistant' },
          content: { parts: [`${item.title}的回答`] },
          create_time: item.update_time
        }
      }
    }
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Mock ChatGPT</title></head><body><main><h1>Mock ChatGPT</h1></main><script src="/chatgpt-vault-bridge.user.js"></script></body></html>');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/chatgpt-vault-bridge.user.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(await readFile(resolve('scripts/chatgpt-vault-bridge.user.js')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/backend-api/conversations') {
    const records = url.searchParams.get('is_archived') === 'true' ? archived : normal;
    const offset = Number(url.searchParams.get('offset') || 0);
    const requestedLimit = Number(url.searchParams.get('limit') || 28);
    const limit = Math.min(40, requestedLimit);
    json(response, 200, {
      items: records.slice(offset, offset + limit),
      total: records.length,
      offset,
      limit
    });
    return;
  }
  const detailMatch = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
  if (request.method === 'GET' && detailMatch) {
    const conversation = detail(decodeURIComponent(detailMatch[1]));
    json(response, conversation ? 200 : 404, conversation || { error: 'missing' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sync/index') {
    json(response, 200, {
      conversations: [
        {
          id: 'remote-000',
          title: '普通会话 0',
          updatedAt: new Date(normal[0].update_time * 1000).toISOString(),
          messageCount: 2
        },
        {
          id: 'remote-001',
          title: '普通会话 1',
          updatedAt: new Date((normal[1].update_time - 50) * 1000).toISOString(),
          messageCount: 2
        }
      ]
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/conversations/import') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const conversation of body.conversations || []) {
      imported.push(conversation.id || conversation.conversation_id);
    }
    json(response, 200, {
      imported: (body.conversations || []).length,
      updated: 0,
      skipped: 0,
      ids: imported
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/test/imported') {
    json(response, 200, { ids: imported });
    return;
  }
  json(response, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock sync server: http://127.0.0.1:${PORT}`);
});
