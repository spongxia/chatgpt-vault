// ==UserScript==
// @name         ChatGPT Vault - Save ChatGPT Locally
// @namespace    https://local.chatgpt-vault/
// @version      1.0.0
// @description  分页扫描完整 ChatGPT 会话目录，选择性、增量同步到本地 ChatGPT Vault
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_SERVER = 'http://127.0.0.1:4318';
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 2000;
  const SYNC_CONCURRENCY = 3;
  const RENDER_BATCH = 200;
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const state = {
    server: localStorage.getItem('chatgpt-vault-server') || DEFAULT_SERVER,
    catalog: [],
    localIndex: new Map(),
    listEndpoint: '',
    detailPatterns: [],
    scanning: false,
    syncing: false,
    cancelScan: false,
    cancelSync: false,
    accessToken: '',
    accountId: '',
    query: '',
    filter: 'recommended',
    visibleLimit: RENDER_BATCH,
    scanStats: {
      fetched: 0,
      reported: 0,
      archived: 0,
      pages: 0,
      complete: false,
      warnings: []
    }
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toIso(value, fallback = new Date().toISOString()) {
    if (value === null || value === undefined || value === '') return fallback;
    const numeric = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    const date = new Date(typeof numeric === 'number' && numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未知时间';
    return new Intl.DateTimeFormat('zh-CN', {
      year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function text(element) {
    return String(element && (element.innerText || element.textContent) || '')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function localRequest(path, options = {}) {
    const url = state.server.replace(/\/$/, '') + path;
    const method = options.method || 'GET';
    const body = options.body ? JSON.stringify(options.body) : undefined;

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-ChatGPT-Vault': '1'
          },
          data: body,
          timeout: options.timeout || 120000,
          onload(response) {
            let payload = {};
            try {
              payload = response.responseText ? JSON.parse(response.responseText) : {};
            } catch {
              reject(new Error('本地服务返回了无法解析的数据'));
              return;
            }
            if (response.status >= 200 && response.status < 300) resolve(payload);
            else reject(new Error(payload.error || `本地服务错误（${response.status}）`));
          },
          ontimeout() {
            reject(new Error('连接本地服务超时'));
          },
          onerror() {
            reject(new Error('无法连接 ChatGPT Vault，请先运行 npm start'));
          }
        });
        return;
      }

      fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-ChatGPT-Vault': '1'
        },
        body
      }).then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `本地服务错误（${response.status}）`);
        resolve(payload);
      }).catch(reject);
    });
  }

  async function getAccessToken() {
    if (state.accessToken) return state.accessToken;
    const fetchFunction = pageWindow.fetch || window.fetch;
    const response = await fetchFunction.call(pageWindow, new URL('/api/auth/session', location.origin).href, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json'
      }
    });
    if (!response.ok) return '';
    const session = await response.json().catch(() => ({}));
    state.accessToken = String(session?.accessToken || session?.access_token || '');
    state.accountId = String(
      session?.account?.id
      || session?.account_id
      || session?.user?.account_id
      || ''
    );
    return state.accessToken;
  }

  async function pageFetchJson(url, retriedWithToken = false) {
    const fetchFunction = pageWindow.fetch || window.fetch;
    const headers = { Accept: 'application/json' };
    if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
    if (state.accountId) headers['ChatGPT-Account-Id'] = state.accountId;
    let response = await fetchFunction.call(pageWindow, url, {
      method: 'GET',
      credentials: 'include',
      headers
    });
    if ([401, 403].includes(response.status) && !retriedWithToken && !state.accessToken) {
      const token = await getAccessToken();
      if (token) return pageFetchJson(url, true);
    }
    if (!response.ok) {
      const error = new Error(`ChatGPT 请求失败（${response.status}）`);
      error.status = response.status;
      error.url = url;
      throw error;
    }
    return response.json();
  }

  function discoverEndpoints() {
    const listCandidates = [];
    const detailPatterns = [];
    const entries = pageWindow.performance?.getEntriesByType?.('resource') || [];

    for (const entry of entries) {
      try {
        const url = new URL(entry.name);
        if (url.origin !== location.origin) continue;
        if (/\/conversations(?:\/list)?\/?$/.test(url.pathname)) {
          listCandidates.push(url.pathname);
        }
        const detailMatch = url.pathname.match(/^(.*\/conversation(?:s)?\/)([^/]+)$/);
        if (detailMatch && !['search', 'list'].includes(detailMatch[2])) {
          detailPatterns.push(`${detailMatch[1]}{id}`);
        }
      } catch {
        // Ignore browser-internal and malformed resource names.
      }
    }

    listCandidates.push('/backend-api/conversations');
    detailPatterns.push('/backend-api/conversation/{id}', '/backend-api/conversations/{id}');

    state.detailPatterns = [...new Set(detailPatterns)];
    return [...new Set(listCandidates)];
  }

  function parseCatalogPage(payload) {
    const candidates = [
      payload?.items,
      payload?.conversations,
      payload?.data?.items,
      payload?.data?.conversations,
      Array.isArray(payload?.data) ? payload.data : null,
      Array.isArray(payload) ? payload : null
    ];
    const items = candidates.find(Array.isArray);
    if (!items) throw new Error('无法识别 ChatGPT 会话目录返回格式');

    const totalCandidates = [
      payload?.total,
      payload?.count,
      payload?.data?.total,
      payload?.data?.count
    ];
    const total = totalCandidates.find(value => Number.isFinite(Number(value)));
    const nextCursor = payload?.next_cursor
      || payload?.nextCursor
      || payload?.cursor?.next
      || payload?.data?.next_cursor
      || payload?.data?.nextCursor
      || '';
    const hasMoreCandidates = [
      payload?.has_more,
      payload?.hasMore,
      payload?.data?.has_more,
      payload?.data?.hasMore
    ];
    const hasMore = hasMoreCandidates.find(value => typeof value === 'boolean');
    const missing = Boolean(
      payload?.has_missing_conversations
      || payload?.hasMissingConversations
      || payload?.data?.has_missing_conversations
    );

    return {
      items,
      total: total === undefined ? null : Number(total),
      nextCursor: String(nextCursor || ''),
      hasMore,
      missing
    };
  }

  function normalizeCatalogItem(raw, archivedFallback = false) {
    const id = String(
      raw?.id
      || raw?.conversation_id
      || raw?.conversationId
      || ''
    ).trim();
    if (!id) return null;
    const updatedAt = toIso(
      raw?.update_time
      ?? raw?.updated_at
      ?? raw?.updatedAt
      ?? raw?.create_time
      ?? raw?.created_at
    );
    return {
      id,
      title: String(raw?.title || raw?.name || '未命名对话').trim(),
      createdAt: toIso(raw?.create_time ?? raw?.created_at ?? raw?.createdAt, updatedAt),
      updatedAt,
      archived: typeof raw?.is_archived === 'boolean'
        ? raw.is_archived
        : typeof raw?.archived === 'boolean'
          ? raw.archived
          : archivedFallback,
      workspaceId: String(raw?.workspace_id || raw?.workspaceId || ''),
      raw,
      status: 'new',
      selected: false,
      error: ''
    };
  }

  function buildCatalogUrl(endpoint, { offset, cursor, archived, limit }) {
    const url = new URL(endpoint, location.origin);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('order', 'updated');
    url.searchParams.set('is_archived', archived ? 'true' : 'false');
    if (cursor) {
      url.searchParams.delete('offset');
      url.searchParams.set('cursor', cursor);
    } else {
      url.searchParams.delete('cursor');
      url.searchParams.set('offset', String(offset));
    }
    return url.href;
  }

  async function scanCategory(endpoint, archived) {
    const records = new Map();
    let offset = 0;
    let cursor = '';
    let reported = null;
    let page = 0;
    let missing = false;
    let complete = false;
    let lastSignature = '';
    let effectiveLimit = PAGE_LIMIT;

    while (!state.cancelScan && page < MAX_PAGES) {
      const url = buildCatalogUrl(endpoint, {
        offset,
        cursor,
        archived,
        limit: effectiveLimit
      });
      let payload;
      try {
        payload = await pageFetchJson(url);
      } catch (error) {
        if (page === 0 && effectiveLimit > 28 && [400, 422].includes(error.status)) {
          effectiveLimit = 28;
          continue;
        }
        throw error;
      }

      const parsed = parseCatalogPage(payload);
      page += 1;
      state.scanStats.pages += 1;
      if (parsed.total !== null) reported = parsed.total;
      missing ||= parsed.missing;

      const normalized = parsed.items
        .map(item => normalizeCatalogItem(item, archived))
        .filter(Boolean);
      const signature = normalized.slice(0, 5).map(item => item.id).join('|');
      if (page > 1 && signature && signature === lastSignature) {
        state.scanStats.warnings.push(
          `${archived ? '归档' : '普通'}目录返回了重复分页，已停止以避免无限循环`
        );
        break;
      }
      lastSignature = signature;
      for (const item of normalized) records.set(item.id, item);

      state.scanStats.fetched = records.size;
      updateScanProgress({
        label: archived ? '正在扫描归档会话' : '正在扫描全部会话',
        fetched: records.size,
        reported
      });

      if (parsed.items.length === 0) {
        complete = reported === null || records.size >= reported;
        break;
      }
      if (parsed.nextCursor && parsed.nextCursor !== cursor) {
        cursor = parsed.nextCursor;
      } else {
        cursor = '';
        offset += parsed.items.length;
      }

      if (reported !== null && records.size >= reported) {
        complete = true;
        break;
      }
      if (parsed.hasMore === false) {
        complete = reported === null || records.size >= reported;
        break;
      }
      if (parsed.hasMore === undefined && reported === null && parsed.items.length < effectiveLimit) {
        complete = true;
        break;
      }
    }

    if (page >= MAX_PAGES) {
      state.scanStats.warnings.push('目录页数超过安全上限，扫描已停止');
    }
    if (missing) {
      state.scanStats.warnings.push(
        'ChatGPT 返回了 has_missing_conversations 标记；已继续翻完可用分页，但远端目录本身可能仍在重建'
      );
    }
    if (reported !== null && records.size < reported) {
      state.scanStats.warnings.push(
        `${archived ? '归档' : '普通'}目录报告 ${reported} 条，但只读取到 ${records.size} 条`
      );
    }

    return {
      records,
      reported,
      complete,
      missing,
      pages: page
    };
  }

  async function loadLocalIndex() {
    const payload = await localRequest('/api/sync/index');
    state.localIndex = new Map(
      (payload.conversations || []).map(conversation => [conversation.id, conversation])
    );
    return state.localIndex;
  }

  function compareWithLocal(item) {
    const local = state.localIndex.get(item.id);
    if (!local) {
      item.status = 'new';
      item.selected = true;
      return;
    }
    const remoteTime = Date.parse(item.updatedAt);
    const localTime = Date.parse(local.updatedAt);
    if (!Number.isFinite(remoteTime)) {
      item.status = 'unknown';
      item.selected = true;
    } else if (!Number.isFinite(localTime) || remoteTime > localTime + 1000) {
      item.status = 'changed';
      item.selected = true;
    } else {
      item.status = 'synced';
      item.selected = false;
    }
  }

  async function scanRemote() {
    if (state.scanning || state.syncing) return;
    state.scanning = true;
    state.cancelScan = false;
    state.catalog = [];
    state.visibleLimit = RENDER_BATCH;
    state.scanStats = {
      fetched: 0,
      reported: 0,
      archived: 0,
      pages: 0,
      complete: false,
      warnings: []
    };
    setBusyState();
    showNotice('正在连接本地 ChatGPT Vault，并从 ChatGPT 远端目录逐页扫描…', 'info');

    try {
      await Promise.all([
        loadLocalIndex(),
        getAccessToken().catch(() => '')
      ]);
      const candidates = discoverEndpoints();
      let normalResult = null;
      let selectedEndpoint = '';
      let lastError = null;

      for (const endpoint of candidates) {
        try {
          normalResult = await scanCategory(endpoint, false);
          selectedEndpoint = endpoint;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!normalResult) {
        throw new Error(
          lastError?.status === 401 || lastError?.status === 403
            ? 'ChatGPT 登录状态不可用，请刷新页面并确认已经登录'
            : '当前 ChatGPT 内部目录接口不可用，可能刚刚改版'
        );
      }
      state.listEndpoint = selectedEndpoint;

      let archivedResult = {
        records: new Map(),
        reported: 0,
        complete: true,
        pages: 0
      };
      try {
        archivedResult = await scanCategory(selectedEndpoint, true);
      } catch (error) {
        state.scanStats.warnings.push(`归档目录读取失败：${error.message}`);
      }

      const combined = new Map(normalResult.records);
      let archivedAdded = 0;
      let archivedExplicit = false;
      for (const [id, item] of archivedResult.records) {
        const existing = combined.get(id);
        const explicitlyArchived = item.raw?.is_archived === true || item.raw?.archived === true;
        archivedExplicit ||= explicitlyArchived;
        if (!existing || explicitlyArchived) {
          item.archived = true;
          combined.set(id, item);
          if (!existing) archivedAdded += 1;
        }
      }
      const archivedVerified = archivedResult.records.size === 0
        || archivedAdded > 0
        || archivedExplicit;
      if (!archivedVerified && normalResult.records.size > 0) {
        state.scanStats.warnings.push(
          '归档目录返回了与普通目录相同的数据，无法确认当前接口是否支持归档筛选'
        );
      }

      state.catalog = [...combined.values()]
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      state.catalog.forEach(compareWithLocal);
      state.scanStats.fetched = state.catalog.length;
      state.scanStats.archived = archivedAdded;
      state.scanStats.reported = Math.max(
        state.catalog.length,
        (normalResult.reported || normalResult.records.size) + archivedAdded
      );
      state.scanStats.complete = Boolean(
        normalResult.complete
        && archivedResult.complete
        && archivedVerified
        && state.scanStats.fetched >= state.scanStats.reported
      );

      if (state.scanStats.complete) {
        showNotice(
          `完整扫描完成：读取 ${state.catalog.length} 条会话，其中归档 ${archivedAdded} 条。页面是否加载过这些会话不会影响结果。`,
          'success'
        );
      } else {
        showNotice(
          `扫描结束，但完整性检查未通过：读取 ${state.catalog.length} 条，远端报告至少 ${state.scanStats.reported} 条。请查看警告后重试。`,
          'warning'
        );
      }
      renderAll();
    } catch (error) {
      showNotice(error.message, 'error');
      state.scanStats.warnings.push(error.message);
      renderAll();
    } finally {
      state.scanning = false;
      state.cancelScan = false;
      setBusyState();
    }
  }

  function detailUrlCandidates(id) {
    const encoded = encodeURIComponent(id);
    return [...new Set(
      state.detailPatterns.map(pattern => pattern.replace('{id}', encoded))
    )];
  }

  async function fetchConversation(item) {
    let lastError = null;
    for (const endpoint of detailUrlCandidates(item.id)) {
      try {
        const payload = await pageFetchJson(new URL(endpoint, location.origin).href);
        const raw = payload?.conversation?.mapping
          ? payload.conversation
          : payload?.mapping
            ? payload
            : payload?.data?.mapping
              ? payload.data
              : null;
        if (!raw) {
          lastError = new Error('会话详情返回格式无法识别');
          continue;
        }
        return {
          ...raw,
          id: raw.id || raw.conversation_id || item.id,
          title: raw.title || item.title,
          create_time: raw.create_time || item.raw?.create_time || item.createdAt,
          update_time: raw.update_time || item.raw?.update_time || item.updatedAt,
          is_archived: item.archived,
          source: 'chatgpt-live'
        };
      } catch (error) {
        lastError = error;
        if (![404, 405].includes(error.status)) break;
      }
    }
    throw lastError || new Error('无法读取会话详情');
  }

  async function syncSelected() {
    if (state.syncing || state.scanning) return;
    const queue = state.catalog.filter(item => item.selected);
    if (!queue.length) {
      showNotice('请先勾选需要同步的会话', 'warning');
      return;
    }

    state.syncing = true;
    state.cancelSync = false;
    let cursor = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    setBusyState();
    updateSyncProgress(completed, queue.length, '准备同步');
    showNotice(`开始同步 ${queue.length} 条会话，只会请求已勾选的详情。`, 'info');

    async function worker() {
      while (!state.cancelSync) {
        const itemIndex = cursor;
        cursor += 1;
        if (itemIndex >= queue.length) return;
        const item = queue[itemIndex];
        item.status = 'syncing';
        item.error = '';
        scheduleRender();

        try {
          const conversation = await fetchConversation(item);
          await localRequest('/api/conversations/import', {
            method: 'POST',
            body: { conversations: [conversation] }
          });
          item.status = 'synced';
          item.selected = false;
          succeeded += 1;
        } catch (error) {
          item.status = 'failed';
          item.error = error.message;
          item.selected = true;
          failed += 1;
        }

        completed += 1;
        updateSyncProgress(completed, queue.length, `已完成 ${completed} / ${queue.length}`);
        scheduleRender();
        await delay(90 + Math.floor(Math.random() * 130));
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker)
      );
      await loadLocalIndex().catch(() => state.localIndex);
      if (state.cancelSync) {
        showNotice(`同步已停止：成功 ${succeeded} 条，失败 ${failed} 条。`, 'warning');
      } else if (failed) {
        showNotice(
          `同步完成：成功 ${succeeded} 条，失败 ${failed} 条。筛选“失败”可以重试。`,
          'warning'
        );
      } else {
        showNotice(`同步完成：${succeeded} 条会话已经保存到本地 ChatGPT Vault。`, 'success');
      }
    } finally {
      state.syncing = false;
      state.cancelSync = false;
      setBusyState();
      renderAll();
    }
  }

  function markdownFromElement(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('button, svg, [aria-hidden="true"]').forEach(node => node.remove());
    clone.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code') || pre;
      const language = (code.className || '').match(/language-([\w+#.-]+)/)?.[1] || '';
      code.replaceWith(document.createTextNode(
        `\n${String.fromCharCode(96).repeat(3)}${language}\n${text(code)}\n${String.fromCharCode(96).repeat(3)}\n`
      ));
    });
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
    clone.querySelectorAll('li').forEach(li => li.insertBefore(document.createTextNode('- '), li.firstChild));
    clone.querySelectorAll('p, div, blockquote, tr').forEach(node => {
      node.insertBefore(document.createTextNode('\n'), node.firstChild);
      node.appendChild(document.createTextNode('\n'));
    });
    return text(clone).replace(/\n{3,}/g, '\n\n').trim();
  }

  function senderFor(element, index) {
    const role = element.getAttribute?.('data-message-author-role') || '';
    if (/^user$/i.test(role)) return 'user';
    if (/^(assistant|model)$/i.test(role)) return 'assistant';
    const signal = [
      element.className,
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\b(user|human|query)\b/.test(signal)) return 'user';
    if (/\b(assistant|model|response|chatgpt)\b/.test(signal)) return 'assistant';
    return index % 2 === 0 ? 'user' : 'assistant';
  }

  function fallbackExtractCurrent() {
    const elements = Array.from(document.querySelectorAll(
      '[data-message-author-role], article[data-testid*="conversation-turn"], [data-testid="conversation-turn"], [class*="conversation-turn"]'
    ));
    const seen = new Set();
    const messages = [];
    elements.forEach((element, index) => {
      const contentRoot = [
        '.markdown',
        '.prose',
        '[data-message-content]',
        '[class*="markdown"]',
        '[class*="prose"]',
        '.whitespace-pre-wrap'
      ].map(selector => element.querySelector?.(selector)).find(Boolean) || element;
      const content = markdownFromElement(contentRoot);
      const key = content.replace(/\s+/g, ' ').slice(0, 220);
      if (!content || key.length < 2 || seen.has(key)) return;
      seen.add(key);
      messages.push({
        id: `message-${messages.length + 1}`,
        role: senderFor(element, index),
        content,
        createdAt: new Date().toISOString()
      });
    });
    const title = (document.title || 'ChatGPT 对话')
      .replace(/\s*[|–-]\s*ChatGPT.*$/i, '')
      .trim() || 'ChatGPT 对话';
    const id = location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || `local-${Date.now()}`;
    return {
      id,
      title,
      source: 'chatgpt-live',
      sourceUrl: location.href,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages
    };
  }

  function extractCurrent() {
    try {
      const engine = pageWindow.ChatExporterEngine;
      if (engine && typeof engine.extractConversation === 'function') {
        const conversation = engine.extractConversation({
          provider: 'chatgpt',
          format: 'markdown',
          includeSourceUrl: true,
          document
        });
        return {
          id: location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || `local-${Date.now()}`,
          title: conversation.title,
          source: 'chatgpt-live',
          sourceUrl: conversation.sourceUrl || location.href,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: conversation.messages.map((message, index) => ({
            id: `message-${index + 1}`,
            role: message.senderType === 'user' || message.sender === 'You' ? 'user' : 'assistant',
            content: message.content,
            createdAt: new Date().toISOString()
          }))
        };
      }
    } catch (error) {
      console.warn('[ChatGPT Vault] Existing exporter engine unavailable:', error);
    }
    return fallbackExtractCurrent();
  }

  async function saveCurrent() {
    try {
      const conversation = extractCurrent();
      if (!conversation.messages.length) {
        throw new Error('当前页面没有找到可保存的消息');
      }
      const result = await localRequest('/api/conversations/import', {
        method: 'POST',
        body: { conversations: [conversation] }
      });
      showNotice(result.updated ? '当前对话已更新到本地' : '当前对话已保存到本地', 'success');
      await loadLocalIndex().catch(() => state.localIndex);
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  function configure() {
    const value = prompt('ChatGPT Vault 服务地址', state.server);
    if (!value) return;
    state.server = value.replace(/\/$/, '');
    localStorage.setItem('chatgpt-vault-server', state.server);
    showNotice('已更新本地服务地址', 'success');
  }

  const statusMeta = {
    new: { label: '未保存', className: 'new' },
    changed: { label: '有更新', className: 'changed' },
    unknown: { label: '待核对', className: 'unknown' },
    synced: { label: '已同步', className: 'synced' },
    syncing: { label: '同步中', className: 'syncing' },
    failed: { label: '失败', className: 'failed' }
  };

  function filteredCatalog() {
    const query = state.query.trim().toLocaleLowerCase('zh-CN');
    return state.catalog.filter(item => {
      if (query && !`${item.title}\n${item.id}`.toLocaleLowerCase('zh-CN').includes(query)) {
        return false;
      }
      if (state.filter === 'recommended') {
        return ['new', 'changed', 'unknown', 'failed'].includes(item.status);
      }
      if (state.filter === 'archived') return item.archived;
      if (state.filter !== 'all') return item.status === state.filter;
      return true;
    });
  }

  function renderStats() {
    const counts = state.catalog.reduce((result, item) => {
      result[item.status] = (result[item.status] || 0) + 1;
      return result;
    }, {});
    ui.stats.innerHTML = [
      ['总目录', state.catalog.length, 'total'],
      ['建议同步', (counts.new || 0) + (counts.changed || 0) + (counts.unknown || 0) + (counts.failed || 0), 'pending'],
      ['未保存', counts.new || 0, 'new'],
      ['有更新', counts.changed || 0, 'changed'],
      ['已同步', counts.synced || 0, 'synced'],
      ['归档', state.scanStats.archived, 'archived']
    ].map(([label, value, className]) => (
      `<div class="stat ${className}"><strong>${value}</strong><span>${label}</span></div>`
    )).join('');
  }

  function renderRows() {
    const records = filteredCatalog();
    const visible = records.slice(0, state.visibleLimit);
    ui.list.innerHTML = visible.length
      ? visible.map(item => {
        const meta = statusMeta[item.status] || statusMeta.unknown;
        return `
          <label class="conversation-row ${item.selected ? 'selected' : ''} ${item.status === 'failed' ? 'has-error' : ''}">
            <input type="checkbox" data-id="${escapeHtml(item.id)}" ${item.selected ? 'checked' : ''}>
            <span class="checkmark"></span>
            <span class="conversation-copy">
              <span class="title-line">
                <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
                ${item.archived ? '<span class="archive-pill">归档</span>' : ''}
              </span>
              <small>${formatDate(item.updatedAt)} · ${escapeHtml(item.id)}</small>
              ${item.error ? `<em>${escapeHtml(item.error)}</em>` : ''}
            </span>
            <span class="status ${meta.className}">${meta.label}</span>
          </label>
        `;
      }).join('')
      : '<div class="empty">没有符合当前筛选条件的会话</div>';
    ui.resultCount.textContent = `显示 ${Math.min(visible.length, records.length)} / ${records.length}`;
    ui.loadMore.hidden = visible.length >= records.length;
    ui.selectedCount.textContent = `已选择 ${state.catalog.filter(item => item.selected).length} 条`;
    ui.master.checked = records.length > 0 && records.every(item => item.selected);
    ui.master.indeterminate = records.some(item => item.selected) && !records.every(item => item.selected);
  }

  function renderWarnings() {
    ui.warnings.innerHTML = state.scanStats.warnings.length
      ? state.scanStats.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')
      : '';
    ui.warningsWrap.hidden = !state.scanStats.warnings.length;
    ui.completeness.textContent = state.catalog.length
      ? `目录接口：${state.listEndpoint || '未识别'} · ${state.scanStats.pages} 页 · 读取 ${state.scanStats.fetched} 条 · 远端报告至少 ${state.scanStats.reported} 条`
      : '尚未扫描远端会话目录';
    ui.completeBadge.textContent = state.scanStats.complete ? '完整性通过' : '尚未确认完整';
    ui.completeBadge.className = `complete-badge ${state.scanStats.complete ? 'complete' : 'incomplete'}`;
  }

  function renderAll() {
    renderStats();
    renderRows();
    renderWarnings();
    setBusyState();
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 100);
  }

  function showNotice(message, type = 'info') {
    ui.notice.textContent = message;
    ui.notice.className = `notice ${type}`;
    ui.notice.hidden = false;
  }

  function updateScanProgress({ label, fetched, reported }) {
    const percent = reported
      ? Math.min(99, Math.round((fetched / reported) * 100))
      : Math.min(95, state.scanStats.pages * 4);
    ui.progress.hidden = false;
    ui.progressLabel.textContent = `${label}：${fetched}${reported ? ` / ${reported}` : ''}`;
    ui.progressBar.style.width = `${percent}%`;
  }

  function updateSyncProgress(completed, total, label) {
    ui.progress.hidden = false;
    ui.progressLabel.textContent = label;
    ui.progressBar.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
    if (completed >= total) {
      setTimeout(() => {
        if (!state.scanning && !state.syncing) ui.progress.hidden = true;
      }, 700);
    }
  }

  function setBusyState() {
    ui.scanButton.disabled = state.scanning || state.syncing;
    ui.syncButton.disabled = state.scanning || state.syncing || !state.catalog.some(item => item.selected);
    ui.saveCurrentButton.disabled = state.scanning || state.syncing;
    ui.stopButton.hidden = !state.scanning && !state.syncing;
    ui.scanButton.textContent = state.scanning ? '正在深度扫描…' : '重新扫描完整目录';
    ui.syncButton.textContent = state.syncing ? '正在同步…' : '同步所选到本地';
  }

  function openPanel() {
    ui.overlay.classList.add('open');
    document.documentElement.style.setProperty('--chatgpt-vault-scroll-lock', 'hidden');
    if (!state.catalog.length && !state.scanning) scanRemote();
  }

  function closePanel() {
    ui.overlay.classList.remove('open');
    document.documentElement.style.removeProperty('--chatgpt-vault-scroll-lock');
  }

  const host = document.createElement('div');
  host.id = 'chatgpt-vault-sync-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input, select { font: inherit; }
      .launcher {
        position: fixed; z-index: 2147483640; right: 20px; bottom: 20px;
        display: flex; align-items: center; gap: 8px; padding: 11px 15px;
        color: white; background: #1f6f5f; border: 0; border-radius: 11px;
        box-shadow: 0 6px 22px rgb(0 0 0 / 20%); cursor: pointer;
        font: 650 13px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      .launcher:hover { background: #17594c; transform: translateY(-1px); }
      .launcher svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; }
      .overlay {
        position: fixed; z-index: 2147483641; inset: 0; display: none;
        align-items: center; justify-content: center; padding: 18px;
        background: rgb(12 18 15 / 55%); backdrop-filter: blur(3px);
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        color: #202622;
      }
      .overlay.open { display: flex; }
      .panel {
        display: flex; flex-direction: column; width: min(1040px, 96vw); height: min(800px, 92vh);
        overflow: hidden; background: #fbfaf7; border: 1px solid #d9ded9; border-radius: 17px;
        box-shadow: 0 28px 90px rgb(0 0 0 / 28%);
      }
      .header { display: flex; align-items: flex-start; gap: 14px; padding: 19px 22px 16px; border-bottom: 1px solid #e1e4df; }
      .header-copy { flex: 1; }
      .eyebrow { display: block; margin-bottom: 4px; color: #1f6f5f; font-size: 9px; font-weight: 750; letter-spacing: .15em; }
      h2 { margin: 0; font: 700 23px Georgia, "Songti SC", serif; }
      .header p { margin: 5px 0 0; color: #747b75; font-size: 10px; line-height: 1.5; }
      .header-actions { display: flex; gap: 7px; }
      button { border: 0; cursor: pointer; }
      button:disabled { cursor: default; opacity: .48; }
      .button { padding: 9px 12px; color: #27302b; background: white; border: 1px solid #d9ded9; border-radius: 8px; font-size: 10px; font-weight: 650; }
      .button:hover:not(:disabled) { background: #f0f2ee; }
      .button.primary { color: white; background: #1f6f5f; border-color: #1f6f5f; }
      .button.primary:hover:not(:disabled) { background: #17594c; }
      .icon-button { width: 34px; height: 34px; background: transparent; border-radius: 8px; font-size: 22px; line-height: 1; }
      .icon-button:hover { background: #eef0ec; }
      .notice { margin: 12px 22px 0; padding: 9px 11px; border-radius: 8px; font-size: 10px; line-height: 1.5; }
      .notice.info { color: #315b51; background: #e8f2ef; }
      .notice.success { color: #215848; background: #e3f3ed; }
      .notice.warning { color: #795a1d; background: #fbf1d9; }
      .notice.error { color: #9f332c; background: #fbe8e5; }
      .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 7px; padding: 12px 22px; }
      .stat { display: flex; flex-direction: column; gap: 1px; padding: 9px 10px; background: white; border: 1px solid #e1e4df; border-radius: 9px; }
      .stat strong { font-size: 16px; font-family: Georgia, serif; }
      .stat span { color: #899089; font-size: 8px; }
      .toolbar { display: flex; align-items: center; gap: 7px; padding: 0 22px 11px; }
      .search { flex: 1; min-width: 160px; padding: 9px 11px; color: #202622; background: white; border: 1px solid #d9ded9; border-radius: 8px; outline: none; font-size: 10px; }
      .search:focus { border-color: #1f6f5f; box-shadow: 0 0 0 3px rgb(31 111 95 / 10%); }
      select { padding: 8px 28px 8px 9px; color: #4d554f; background: white; border: 1px solid #d9ded9; border-radius: 8px; font-size: 10px; }
      .progress { margin: 0 22px 10px; }
      .progress-copy { display: flex; justify-content: space-between; margin-bottom: 4px; color: #7b827c; font-size: 9px; }
      .progress-track { height: 4px; overflow: hidden; background: #e2e5e1; border-radius: 3px; }
      .progress-bar { width: 0; height: 100%; background: #1f6f5f; transition: width .2s; }
      .completeness { display: flex; align-items: center; gap: 8px; padding: 8px 22px; color: #7b827c; background: #f2f2ee; border-block: 1px solid #e1e4df; font-size: 9px; }
      .completeness span:first-child { flex: 1; }
      .complete-badge { padding: 3px 7px; border-radius: 10px; font-weight: 700; }
      .complete-badge.complete { color: #1c6553; background: #dcefe8; }
      .complete-badge.incomplete { color: #8a621a; background: #f6e8c5; }
      .list-head { display: grid; grid-template-columns: 28px 1fr 90px; align-items: center; padding: 8px 24px; color: #8a918b; border-bottom: 1px solid #e1e4df; font-size: 9px; }
      .list-head input { width: 14px; height: 14px; accent-color: #1f6f5f; }
      .conversation-list { flex: 1; min-height: 0; overflow: auto; background: white; }
      .conversation-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 90px; align-items: center; min-height: 55px; padding: 8px 24px; border-bottom: 1px solid #eceeea; cursor: pointer; }
      .conversation-row:hover, .conversation-row.selected { background: #f3f7f5; }
      .conversation-row.has-error { background: #fff8f7; }
      .conversation-row input { position: absolute; opacity: 0; pointer-events: none; }
      .checkmark { width: 15px; height: 15px; border: 1.5px solid #aab0aa; border-radius: 4px; }
      .conversation-row input:checked + .checkmark { position: relative; background: #1f6f5f; border-color: #1f6f5f; }
      .conversation-row input:checked + .checkmark::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .conversation-copy { min-width: 0; padding-right: 12px; }
      .title-line { display: flex; align-items: center; gap: 6px; }
      .title-line strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .conversation-copy small { display: block; margin-top: 3px; overflow: hidden; color: #8a918b; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
      .conversation-copy em { display: block; margin-top: 3px; color: #b33d34; font-size: 8px; font-style: normal; }
      .archive-pill { padding: 2px 5px; color: #6d6653; background: #ece8db; border-radius: 4px; font-size: 7px; }
      .status { justify-self: end; padding: 4px 7px; border-radius: 10px; font-size: 8px; font-weight: 700; }
      .status.new { color: #216451; background: #dff0e9; }
      .status.changed { color: #855d13; background: #f7e9c2; }
      .status.unknown { color: #6c568e; background: #eee7f6; }
      .status.synced { color: #68706a; background: #ebedea; }
      .status.syncing { color: #2f6385; background: #e0eef7; }
      .status.failed { color: #a3362f; background: #f8e4e2; }
      .empty { display: grid; place-items: center; height: 160px; color: #899089; font-size: 10px; }
      .load-more { display: block; margin: 10px auto; padding: 7px 14px; color: #1f6f5f; background: #e7f1ed; border-radius: 7px; font-size: 9px; }
      .warnings-wrap { max-height: 86px; overflow: auto; padding: 8px 22px; color: #795a1d; background: #fff7e6; border-top: 1px solid #ebdfc6; font-size: 9px; }
      .warnings-wrap strong { display: block; margin-bottom: 3px; }
      .warnings { margin: 0; padding-left: 16px; line-height: 1.5; }
      .footer { display: flex; align-items: center; gap: 8px; padding: 12px 22px; background: #fbfaf7; border-top: 1px solid #e1e4df; }
      .footer .selected-count { flex: 1; color: #707770; font-size: 10px; }
      .stop { color: #a33b34; }
      @media (max-width: 700px) {
        .overlay { padding: 0; }
        .panel { width: 100vw; height: 100vh; border: 0; border-radius: 0; }
        .header { padding: 15px; }
        .header-actions .button:not(.primary) { display: none; }
        .stats { grid-template-columns: repeat(3, 1fr); padding-inline: 15px; }
        .toolbar { flex-wrap: wrap; padding-inline: 15px; }
        .search { flex-basis: 100%; }
        .conversation-row, .list-head { padding-inline: 15px; grid-template-columns: 26px 1fr 68px; }
        .footer { padding-inline: 15px; }
      }
    </style>
    <button class="launcher" id="launcher" title="选择性、增量同步 ChatGPT 会话">
      <svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>
      同步到 ChatGPT Vault
    </button>
    <div class="overlay" id="overlay">
      <section class="panel" role="dialog" aria-modal="true" aria-label="ChatGPT Vault 同步器">
        <header class="header">
          <div class="header-copy">
            <span class="eyebrow">SELECTIVE & INCREMENTAL SYNC</span>
            <h2>选择要保存的聊天记录</h2>
            <p>直接分页读取远端完整目录，不依赖侧边栏当前加载了多少条。只下载勾选的会话详情。</p>
          </div>
          <div class="header-actions">
            <button class="button" id="save-current">保存当前对话</button>
            <button class="button" id="configure">设置</button>
            <button class="icon-button" id="close" aria-label="关闭">×</button>
          </div>
        </header>
        <div class="notice info" id="notice" hidden></div>
        <div class="stats" id="stats"></div>
        <div class="toolbar">
          <input class="search" id="search" type="search" placeholder="筛选标题或会话 ID">
          <select id="filter">
            <option value="recommended">建议同步</option>
            <option value="all">全部目录</option>
            <option value="new">未保存</option>
            <option value="changed">有更新</option>
            <option value="unknown">待核对</option>
            <option value="synced">已同步</option>
            <option value="failed">失败</option>
            <option value="archived">归档</option>
          </select>
          <button class="button" id="select-filtered">选择筛选结果</button>
          <button class="button" id="select-recommended">只选建议项</button>
          <button class="button" id="clear-selection">清空选择</button>
          <button class="button" id="scan">重新扫描完整目录</button>
        </div>
        <div class="progress" id="progress" hidden>
          <div class="progress-copy"><span id="progress-label"></span></div>
          <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
        </div>
        <div class="completeness">
          <span id="completeness">尚未扫描远端会话目录</span>
          <span class="complete-badge incomplete" id="complete-badge">尚未确认完整</span>
        </div>
        <div class="list-head">
          <input id="master" type="checkbox" aria-label="选择当前筛选结果">
          <span>会话</span>
          <span style="text-align:right">状态</span>
        </div>
        <div class="conversation-list" id="list"></div>
        <button class="load-more" id="load-more" hidden>显示更多</button>
        <div class="warnings-wrap" id="warnings-wrap" hidden>
          <strong>完整性提示</strong>
          <ul class="warnings" id="warnings"></ul>
        </div>
        <footer class="footer">
          <span class="selected-count" id="selected-count">已选择 0 条</span>
          <span id="result-count"></span>
          <button class="button stop" id="stop" hidden>停止</button>
          <button class="button primary" id="sync">同步所选到本地</button>
        </footer>
      </section>
    </div>
  `;
  document.documentElement.appendChild(host);

  const ui = {
    launcher: shadow.querySelector('#launcher'),
    overlay: shadow.querySelector('#overlay'),
    close: shadow.querySelector('#close'),
    scanButton: shadow.querySelector('#scan'),
    syncButton: shadow.querySelector('#sync'),
    stopButton: shadow.querySelector('#stop'),
    saveCurrentButton: shadow.querySelector('#save-current'),
    configureButton: shadow.querySelector('#configure'),
    notice: shadow.querySelector('#notice'),
    stats: shadow.querySelector('#stats'),
    search: shadow.querySelector('#search'),
    filter: shadow.querySelector('#filter'),
    selectFiltered: shadow.querySelector('#select-filtered'),
    selectRecommended: shadow.querySelector('#select-recommended'),
    clearSelection: shadow.querySelector('#clear-selection'),
    progress: shadow.querySelector('#progress'),
    progressLabel: shadow.querySelector('#progress-label'),
    progressBar: shadow.querySelector('#progress-bar'),
    completeness: shadow.querySelector('#completeness'),
    completeBadge: shadow.querySelector('#complete-badge'),
    master: shadow.querySelector('#master'),
    list: shadow.querySelector('#list'),
    loadMore: shadow.querySelector('#load-more'),
    warningsWrap: shadow.querySelector('#warnings-wrap'),
    warnings: shadow.querySelector('#warnings'),
    selectedCount: shadow.querySelector('#selected-count'),
    resultCount: shadow.querySelector('#result-count')
  };

  ui.launcher.addEventListener('click', openPanel);
  ui.close.addEventListener('click', closePanel);
  ui.overlay.addEventListener('click', event => {
    if (event.target === ui.overlay) closePanel();
  });
  ui.scanButton.addEventListener('click', scanRemote);
  ui.syncButton.addEventListener('click', syncSelected);
  ui.saveCurrentButton.addEventListener('click', saveCurrent);
  ui.configureButton.addEventListener('click', configure);
  ui.stopButton.addEventListener('click', () => {
    state.cancelScan = state.scanning;
    state.cancelSync = state.syncing;
    showNotice('正在停止当前任务…', 'warning');
  });
  ui.search.addEventListener('input', () => {
    state.query = ui.search.value;
    state.visibleLimit = RENDER_BATCH;
    renderRows();
  });
  ui.filter.addEventListener('change', () => {
    state.filter = ui.filter.value;
    state.visibleLimit = RENDER_BATCH;
    renderRows();
  });
  ui.selectFiltered.addEventListener('click', () => {
    filteredCatalog().forEach(item => {
      if (item.status !== 'syncing') item.selected = true;
    });
    renderRows();
  });
  ui.selectRecommended.addEventListener('click', () => {
    state.catalog.forEach(item => {
      item.selected = ['new', 'changed', 'unknown', 'failed'].includes(item.status);
    });
    renderRows();
  });
  ui.clearSelection.addEventListener('click', () => {
    state.catalog.forEach(item => {
      if (item.status !== 'syncing') item.selected = false;
    });
    renderRows();
  });
  ui.master.addEventListener('change', () => {
    filteredCatalog().forEach(item => {
      if (item.status !== 'syncing') item.selected = ui.master.checked;
    });
    renderRows();
  });
  ui.list.addEventListener('change', event => {
    const input = event.target.closest('input[data-id]');
    if (!input) return;
    const item = state.catalog.find(candidate => candidate.id === input.dataset.id);
    if (item) item.selected = input.checked;
    renderRows();
  });
  ui.loadMore.addEventListener('click', () => {
    state.visibleLimit += RENDER_BATCH;
    renderRows();
  });
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePanel();
  });

  pageWindow.ChatGptVaultSync = {
    open: openPanel,
    scan: scanRemote,
    syncSelected,
    saveCurrent,
    select(ids) {
      const selectedIds = new Set(ids || []);
      state.catalog.forEach(item => {
        item.selected = selectedIds.has(item.id);
      });
      renderRows();
    },
    clearSelection() {
      state.catalog.forEach(item => {
        item.selected = false;
      });
      renderRows();
    },
    getState: () => ({
      catalog: state.catalog.map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
        selected: item.selected,
        archived: item.archived,
        updatedAt: item.updatedAt,
        error: item.error
      })),
      scanStats: { ...state.scanStats },
      listEndpoint: state.listEndpoint
    })
  };

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开 ChatGPT Vault 选择同步器', openPanel);
    GM_registerMenuCommand('深度扫描完整会话目录', () => {
      openPanel();
      scanRemote();
    });
    GM_registerMenuCommand('保存当前对话到 ChatGPT Vault', saveCurrent);
    GM_registerMenuCommand('设置 ChatGPT Vault 服务地址', configure);
  }

  renderAll();
})();
