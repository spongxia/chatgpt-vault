import { handleRichContentClick, isInternalToolMessage, renderConversationMessages } from './renderer.js';
import { getLocale, initI18n, LANGUAGE_OPTIONS, setLanguage, t } from './i18n.js';
import { createConversationJpeg, createConversationPdf, downloadBlob, safeDownloadName } from './exporter.js';

const $ = function (selector) { return document.querySelector(selector); };
const E = { app: $('.app-shell'), sidebar: $('#sidebar'), scrim: $('#scrim'), list: $('#conversation-list'), listTitle: $('#list-title'), listSubtitle: $('#list-subtitle'), search: $('#search-input'), clearSearch: $('#clear-search'), exportAll: $('#export-all-button'), exportAllMenu: $('#export-all-menu'), tagNav: $('#tag-nav'), all: $('#count-all'), favoriteCount: $('#count-favorite'), archived: $('#count-archived'), storage: $('#storage-status'), language: $('#language-select'), welcome: $('#welcome-view'), reader: $('#reader-view'), title: $('#reader-title'), meta: $('#reader-meta'), messages: $('#messages'), favorite: $('#favorite-button'), export: $('#export-button'), more: $('#more-button'), detailsButton: $('#details-button'), details: $('#details-drawer'), detailsContent: $('#details-content'), importDialog: $('#import-dialog'), dropZone: $('#drop-zone'), files: $('#file-input'), progress: $('#import-progress'), moreMenu: $('#more-menu'), exportMenu: $('#export-menu'), textDialog: $('#text-dialog'), textKicker: $('#text-dialog-kicker'), textTitle: $('#text-dialog-title'), textLabel: $('#text-dialog-label'), textInput: $('#text-dialog-input'), textHint: $('#text-dialog-hint'), messageDialog: $('#message-dialog'), messageInput: $('#message-dialog-input'), toasts: $('#toast-region') };
const S = { conversations: [], results: null, current: null, activeId: null, filter: 'all', tag: null, query: '', timer: null, action: null, editingMessage: null };
const COLORS = ['#1f806b', '#a66a24', '#8063a6', '#b04e5a', '#3d72a4', '#6c7f39'];

async function api(path, options) { options = options || {}; const response = await fetch(path, Object.assign({}, options, { headers: Object.assign({ 'Content-Type': 'application/json', 'X-ChatGPT-Vault': '1' }, options.headers || {}) })); const data = await response.json().catch(function () { return {}; }); if (!response.ok) throw new Error(data.error || t('requestFailed')); return data; }
function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function href(value) { try { const url = new URL(value, location.href); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; } }
function date(value, opts) { const d = new Date(value); return Number.isNaN(d.getTime()) ? t('unknownTime') : new Intl.DateTimeFormat(getLocale(), opts || { year: 'numeric', month: 'short', day: 'numeric' }).format(d); }
function relative(value) { const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000); return days <= 0 ? t('today') : days === 1 ? t('yesterday') : days < 7 ? t('daysAgo', { count: days }) : days < 30 ? t('weeksAgo', { count: Math.floor(days / 7) }) : date(value, { month: 'short', day: 'numeric' }); }
function group(value) { const d = new Date(value), now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate()), days = Math.round((start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000); return days <= 0 ? t('today') : days === 1 ? t('yesterday') : days < 7 ? t('recent7') : new Intl.DateTimeFormat(getLocale(), d.getFullYear() === now.getFullYear() ? { month: 'long' } : { year: 'numeric' }).format(d); }
function toast(message, type) { const node = document.createElement('div'); node.className = 'toast ' + (type || 'success'); node.textContent = message; E.toasts.append(node); setTimeout(function () { node.remove(); }, 3500); }
function records() { let list = S.results || S.conversations; if (S.filter === 'all') list = list.filter(function (x) { return !x.archived; }); if (S.filter === 'favorite') list = list.filter(function (x) { return x.favorite && !x.archived; }); if (S.filter === 'archived') list = list.filter(function (x) { return x.archived; }); if (S.filter === 'tag') list = list.filter(function (x) { return x.tags.includes(S.tag) && !x.archived; }); return [...list].sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); }); }
function renderSide() {
  E.all.textContent = S.conversations.filter(function (x) { return !x.archived; }).length; E.favoriteCount.textContent = S.conversations.filter(function (x) { return x.favorite && !x.archived; }).length; E.archived.textContent = S.conversations.filter(function (x) { return x.archived; }).length;
  const counts = new Map(); S.conversations.filter(function (x) { return !x.archived; }).forEach(function (x) { x.tags.forEach(function (tag) { counts.set(tag, (counts.get(tag) || 0) + 1); }); }); E.tagNav.innerHTML = counts.size ? [...counts.entries()].sort(function (a, b) { return a[0].localeCompare(b[0], getLocale()); }).map(function (x, i) { return '<button class="' + (S.filter === 'tag' && S.tag === x[0] ? 'active' : '') + '" data-tag="' + esc(x[0]) + '"><i class="tag-dot" style="--tag-color:' + COLORS[i % COLORS.length] + '"></i><span>' + esc(x[0]) + '</span><small>' + x[1] + '</small></button>'; }).join('') : '<p class="muted-note">' + esc(t('tagEmpty')) + '</p>';
}
function renderList() {
  const list = records(), names = { all: t('allChats'), favorite: t('favorites'), archived: t('archived'), tag: S.tag || t('tags') }; E.listTitle.textContent = names[S.filter]; E.listSubtitle.textContent = S.query ? t('foundResults', { count: list.length }) : t('records', { count: list.length }); E.clearSearch.hidden = !S.query; document.querySelectorAll('.nav-item[data-filter]').forEach(function (button) { button.classList.toggle('active', button.dataset.filter === S.filter); });
  if (!list.length) { E.list.innerHTML = '<div class="list-empty"><svg><use href="#i-search"></use></svg><strong>' + esc(S.query ? t('noResults') : t('noChats')) + '</strong><p>' + esc(S.query ? t('shorterSearch') : t('importToStart')) + '</p></div>'; return; }
  let old = '', html = ''; list.forEach(function (c) { const heading = group(c.updatedAt); if (heading !== old) { html += '<div class="date-group">' + esc(heading) + '</div>'; old = heading; } html += '<button class="conversation-card ' + (c.id === S.activeId ? 'active' : '') + '" data-id="' + esc(c.id) + '"><span class="card-copy"><span class="card-title-row"><h3>' + esc(c.title) + '</h3>' + (c.favorite ? '<svg class="mini-star"><use href="#i-star"></use></svg>' : '') + '</span><p>' + esc(c.preview || t('noPreview')) + '</p><span class="card-foot"><time>' + relative(c.updatedAt) + '</time>' + c.tags.slice(0, 1).map(function (tag) { return '<span class="mini-tag">' + esc(tag) + '</span>'; }).join('') + '<span>' + esc(t('chats', { count: c.visibleMessageCount || c.messageCount })) + '</span></span></span></button>'; }); E.list.innerHTML = html;
}
function renderReader(scrollTop = 0) {
  const c = S.current;
  E.welcome.hidden = Boolean(c);
  E.reader.hidden = !c;
  if (!c) return;
  const visibleMessages = c.messages.filter(function (message, index) {
    return !isInternalToolMessage(message, c.messages[index + 1]);
  });
  const toolMessages = c.messages.length - visibleMessages.length;
  E.title.textContent = c.title;
  E.meta.innerHTML = '<span>' + date(c.createdAt) + '</span><span>' + esc(t('chats', { count: visibleMessages.length })) + '</span>' + (toolMessages ? '<span>' + esc(t('tools', { count: toolMessages })) + '</span>' : '') + (c.model ? '<span>' + esc(c.model) + '</span>' : '');
  E.favorite.classList.toggle('active', c.favorite);
  E.messages.innerHTML = renderConversationMessages(c);
  E.messages.scrollTop = scrollTop;
  const source = c.sourceUrl ? '<a class="detail-source" href="' + esc(href(c.sourceUrl)) + '" target="_blank" rel="noreferrer">' + esc(t('openOriginal')) + '</a>' : esc(t('missingSource'));
  E.detailsContent.innerHTML = '<div class="detail-block"><span class="detail-label">' + esc(t('source')) + '</span><div class="detail-value">' + esc(c.source) + ' · ' + source + '</div></div><div class="detail-block"><span class="detail-label">' + esc(t('created')) + '</span><div class="detail-value">' + date(c.createdAt, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</div></div><div class="detail-block"><span class="detail-label">' + esc(t('conversationMessages')) + '</span><div class="detail-value">' + esc(t('chats', { count: visibleMessages.length })) + '</div></div>' + (toolMessages ? '<div class="detail-block"><span class="detail-label">' + esc(t('toolRecords')) + '</span><div class="detail-value">' + esc(t('tools', { count: toolMessages })) + '</div></div>' : '') + '<div class="detail-block"><span class="detail-label">' + esc(t('tags')) + '</span><div class="detail-tags">' + (c.tags.length ? c.tags.map(function (tag) { return '<span class="detail-tag">' + esc(tag) + '</span>'; }).join('') : esc(t('noTags'))) + '</div></div>';
}
async function refresh() { S.conversations = (await api('/api/conversations')).conversations; if (S.query) await search(); else S.results = null; renderSide(); renderList(); }
async function selectConversation(id) { try { S.activeId = id; renderList(); S.current = (await api('/api/conversations/' + encodeURIComponent(id))).conversation; renderReader(); E.app.classList.add('reading'); } catch (error) { toast(error.message, 'error'); } }
async function patchCurrent(changes, message) { if (!S.current) return; S.current = (await api('/api/conversations/' + encodeURIComponent(S.current.id), { method: 'PATCH', body: JSON.stringify(changes) })).conversation; await refresh(); renderReader(); if (message) toast(message); }
function editMessage(index) {
  const message = S.current?.messages?.[index];
  if (!message) return;
  S.editingMessage = { conversationId: S.current.id, messageId: message.id };
  E.messageInput.value = message.content;
  E.messageDialog.returnValue = 'cancel';
  E.messageDialog.showModal();
  setTimeout(function () { E.messageInput.focus(); }, 20);
}
async function saveEditedMessage(editing, content) {
  const scrollTop = E.messages.scrollTop;
  const result = await api('/api/conversations/' + encodeURIComponent(editing.conversationId) + '/messages/' + encodeURIComponent(editing.messageId), { method: 'PATCH', body: JSON.stringify({ content: content }) });
  if (S.current?.id === editing.conversationId) {
    S.current = result.conversation;
    await refresh();
    renderReader(scrollTop);
  }
  toast(t('messageUpdated'));
}
async function search() { if (!S.query.trim()) { S.results = null; renderList(); return; } S.results = (await api('/api/conversations?q=' + encodeURIComponent(S.query.trim()))).conversations; renderList(); }
function setFilter(filter, tag) { S.filter = filter; S.tag = tag || null; renderSide(); renderList(); E.sidebar.classList.remove('open'); }
function showMenu(menu, button) { E.moreMenu.hidden = true; E.exportMenu.hidden = true; E.exportAllMenu.hidden = true; menu.hidden = false; const r = button.getBoundingClientRect(), w = menu.offsetWidth; menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px'; menu.style.top = Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 5) + 'px'; }
function hideMenus() { E.moreMenu.hidden = true; E.exportMenu.hidden = true; E.exportAllMenu.hidden = true; }
async function hash(value) { const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(buffer)].map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
async function markdownFile(text, name) { const title = ((text.match(/^#\s+(.+)$/m) || [])[1] || name.replace(/\.(md|markdown)$/i, '')).trim(), found = text.match(/^\*\*Date:\*\*\s*(.+)$/mi), created = found && !Number.isNaN(new Date(found[1]).getTime()) ? new Date(found[1]).toISOString() : new Date().toISOString(), messages = [], pattern = /(?:^|\n)###\s+\*\*([^*]+)\*\*\s*\n([\s\S]*?)(?=\n---\s*(?:\n|$))/g; let match; while ((match = pattern.exec(text))) { if (match[2].trim()) messages.push({ id: 'message-' + (messages.length + 1), role: /^(you|user|human|我|你)$/i.test(match[1]) ? 'user' : 'assistant', content: match[2].trim(), createdAt: created }); } if (!messages.length) messages.push({ id: 'message-1', role: 'assistant', content: text.trim(), createdAt: created }); return { id: 'markdown-' + (await hash(title + messages[0].content)).slice(0, 20), title: title, source: 'markdown', sourceUrl: '', createdAt: created, updatedAt: created, messages: messages }; }
function zipEnd(view) { for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) return i; return -1; }
async function zipJson(file) { const buffer = await file.arrayBuffer(), view = new DataView(buffer), end = zipEnd(view); if (end < 0) throw new Error(t('invalidZip')); const decoder = new TextDecoder(), total = view.getUint16(end + 10, true); let cursor = view.getUint32(end + 16, true); for (let i = 0; i < total; i++) { if (view.getUint32(cursor, true) !== 0x02014b50) break; const method = view.getUint16(cursor + 10, true), size = view.getUint32(cursor + 20, true), nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true), name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength)); cursor += 46 + nameLength + extraLength + commentLength; if (!/(^|\/)conversations\.json$/i.test(name)) continue; const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), compressed = new Uint8Array(buffer, start, size); let data = compressed; if (method === 8) data = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); if (method !== 0 && method !== 8) throw new Error(t('unsupportedZip')); return decoder.decode(data); } throw new Error(t('conversationsMissing')); }
async function parseFiles(files) { const items = []; for (const file of files) { const ext = file.name.split('.').pop().toLowerCase(); if (ext === 'zip') { const raw = JSON.parse(await zipJson(file)); items.push(...(Array.isArray(raw) ? raw : raw.conversations || [raw])); } else if (ext === 'json') { const raw = JSON.parse(await file.text()); items.push(...(Array.isArray(raw) ? raw : raw.conversations || [raw])); } else if (ext === 'md' || ext === 'markdown') items.push(await markdownFile(await file.text(), file.name)); else throw new Error(t('unsupportedFile', { name: file.name })); } return items; }
async function importFiles(files) { if (!files || !files.length) return; E.progress.hidden = false; try { const items = await parseFiles([...files]); if (!items.length) throw new Error(t('noImportable')); let totals = { imported: 0, updated: 0 }; for (let i = 0; i < items.length; i += 40) { const result = await api('/api/conversations/import', { method: 'POST', body: JSON.stringify({ conversations: items.slice(i, i + 40) }) }); totals.imported += result.imported; totals.updated += result.updated; E.progress.querySelector('p').textContent = t('processed', { done: Math.min(i + 40, items.length), total: items.length }); } E.importDialog.close(); await refresh(); toast(t('importComplete', totals)); } catch (error) { toast(t('importFailed', { message: error.message }), 'error'); } finally { E.progress.hidden = true; E.progress.querySelector('p').textContent = t('processing'); E.files.value = ''; } }
async function apiBlob(path, expectedType) {
  const response = await fetch(path, { headers: { 'X-ChatGPT-Vault': '1' } });
  if (!response.ok) {
    const data = await response.json().catch(function () { return {}; });
    throw new Error(data.error || t('requestFailed'));
  }
  const contentType = response.headers.get('content-type') || '';
  if (expectedType && !contentType.toLowerCase().includes(expectedType.toLowerCase())) {
    throw new Error(t('serverRestartRequired'));
  }
  return response.blob();
}
async function exportCurrent(format) {
  if (!S.current) return;
  hideMenus();
  E.export.disabled = true;
  try {
    const baseName = safeDownloadName(S.current.title);
    if (format === 'markdown' || format === 'json') {
      const text = format === 'markdown' ? toMarkdown(S.current) : JSON.stringify(S.current, null, 2);
      const blob = new Blob([text], { type: format === 'markdown' ? 'text/markdown' : 'application/json' });
      downloadBlob(blob, baseName + (format === 'markdown' ? '.md' : '.json'));
    } else {
      toast(t('preparingVisualExport'));
      const blob = format === 'jpg' ? await createConversationJpeg(S.current) : await createConversationPdf(S.current);
      downloadBlob(blob, `${baseName}.${format}`);
    }
    toast(t('exported', { format: format === 'markdown' ? 'Markdown' : format.toUpperCase() }));
  } catch (error) {
    toast(t('exportFailed', { message: error.message }), 'error');
  } finally {
    E.export.disabled = false;
  }
}
async function exportAll(format) {
  hideMenus();
  E.exportAll.disabled = true;
  try {
    if (format === 'chatgpt') {
      const payload = await api('/api/conversations/export');
      downloadBlob(new Blob([JSON.stringify(payload.conversations, null, 2)], { type: 'application/json' }), 'conversations.json');
      toast(t('exportAllDone', { count: payload.conversations.length }));
      return;
    }
    const label = format === 'markdown' ? 'Markdown ZIP' : 'JSON ZIP';
    toast(t('preparingArchive', { format: label }));
    const blob = await apiBlob('/api/conversations/export?format=' + encodeURIComponent(format), 'application/zip');
    downloadBlob(blob, `chatgpt-vault-${format}.zip`);
    toast(t('exportArchiveDone', { format: label, count: S.conversations.length }));
  } catch (error) {
    toast(t('exportFailed', { message: error.message }), 'error');
  } finally {
    E.exportAll.disabled = false;
  }
}
function toMarkdown(c) { const lines = ['# ' + c.title, '', '**Date:** ' + c.createdAt.slice(0, 10), '**Source:** ' + c.source, '', '---']; c.messages.forEach(function (m) { lines.push('', '### **' + (m.role === 'user' ? 'You' : 'ChatGPT') + '**', '', m.content, '', '---'); }); return lines.join('\n').trim() + '\n'; }
function dialog(options) { S.action = options.action; E.textKicker.textContent = options.kicker; E.textTitle.textContent = options.title; E.textLabel.textContent = options.label; E.textInput.value = options.value || ''; E.textHint.textContent = options.hint || ''; E.textDialog.showModal(); setTimeout(function () { E.textInput.focus(); E.textInput.select(); }, 20); }
async function removeCurrent() { if (!S.current || !confirm(t('confirmDelete', { title: S.current.title }))) return; await api('/api/conversations/' + encodeURIComponent(S.current.id), { method: 'DELETE' }); S.current = null; S.activeId = null; E.app.classList.remove('reading'); renderReader(); await refresh(); toast(t('deleted')); }
function closeSidebar() { E.sidebar.classList.remove('open'); if (!E.details.classList.contains('open')) E.scrim.hidden = true; }
function theme(value) { document.documentElement.dataset.theme = value; localStorage.setItem('chatgpt-vault-theme', value); $('#theme-toggle use').setAttribute('href', value === 'dark' ? '#i-sun' : '#i-moon'); }
function setPanelCollapsed(panel, collapsed) {
  const className = panel === 'sidebar' ? 'sidebar-collapsed' : 'list-collapsed';
  E.app.classList.toggle(className, collapsed);
  localStorage.setItem(`chatgpt-vault-${panel}-collapsed`, collapsed ? '1' : '0');
}
function restorePanelState() {
  E.app.classList.toggle('sidebar-collapsed', localStorage.getItem('chatgpt-vault-sidebar-collapsed') === '1');
  E.app.classList.toggle('list-collapsed', localStorage.getItem('chatgpt-vault-list-collapsed') === '1');
}
function bind() {
  $('#import-primary').onclick = function () { E.importDialog.showModal(); }; $('#welcome-import').onclick = function () { E.importDialog.showModal(); }; $('#open-help').onclick = function () { $('#help-dialog').showModal(); }; $('#choose-files').onclick = function (e) { e.stopPropagation(); E.files.click(); }; E.dropZone.onclick = function () { E.files.click(); }; E.files.onchange = function () { importFiles(E.files.files); };
  ['dragenter', 'dragover'].forEach(function (name) { E.dropZone.addEventListener(name, function (e) { e.preventDefault(); E.dropZone.classList.add('dragging'); }); }); ['dragleave', 'drop'].forEach(function (name) { E.dropZone.addEventListener(name, function (e) { e.preventDefault(); E.dropZone.classList.remove('dragging'); }); }); E.dropZone.addEventListener('drop', function (e) { importFiles(e.dataTransfer.files); });
  document.querySelectorAll('.nav-item[data-filter]').forEach(function (button) { button.onclick = function () { setFilter(button.dataset.filter); }; }); E.tagNav.onclick = function (e) { const button = e.target.closest('[data-tag]'); if (button) setFilter('tag', button.dataset.tag); }; E.list.onclick = function (e) { const card = e.target.closest('[data-id]'); if (card) selectConversation(card.dataset.id); };
  E.search.oninput = function () { S.query = E.search.value; clearTimeout(S.timer); S.timer = setTimeout(function () { search().catch(function (e) { toast(e.message, 'error'); }); }, 200); renderList(); }; E.clearSearch.onclick = function () { E.search.value = ''; S.query = ''; S.results = null; renderList(); };
  E.exportAll.onclick = function () { showMenu(E.exportAllMenu, E.exportAll); }; E.favorite.onclick = function () { patchCurrent({ favorite: !S.current.favorite }, S.current.favorite ? t('favoriteRemoved') : t('favoriteAdded')); }; E.export.onclick = function () { showMenu(E.exportMenu, E.export); }; E.more.onclick = function () { showMenu(E.moreMenu, E.more); };
  E.exportAllMenu.onclick = function (e) { const button = e.target.closest('[data-batch-format]'); if (button) exportAll(button.dataset.batchFormat); }; E.exportMenu.onclick = function (e) { const button = e.target.closest('[data-format]'); if (button) exportCurrent(button.dataset.format); }; E.moreMenu.onclick = async function (e) { const button = e.target.closest('[data-action]'); if (!button || !S.current) return; hideMenus(); if (button.dataset.action === 'rename') dialog({ kicker: t('organizeConversation'), title: t('rename'), label: t('conversationTitle'), value: S.current.title, action: function (value) { return patchCurrent({ title: value }, t('titleUpdated')); } }); if (button.dataset.action === 'tag') dialog({ kicker: t('organizeConversation'), title: t('editTags'), label: t('tags'), value: S.current.tags.join(', '), hint: t('tagsHint'), action: function (value) { return patchCurrent({ tags: value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) }, t('tagsUpdated')); } }); if (button.dataset.action === 'archive') await patchCurrent({ archived: !S.current.archived }, S.current.archived ? t('unarchived') : t('archivedDone')); if (button.dataset.action === 'delete') await removeCurrent(); };
  E.textDialog.addEventListener('close', function () { if (E.textDialog.returnValue === 'default' && S.action && E.textInput.value.trim()) Promise.resolve(S.action(E.textInput.value.trim())).catch(function (e) { toast(e.message, 'error'); }); S.action = null; }); $('#text-dialog-form').onsubmit = function (e) { if (e.submitter && e.submitter.value === 'cancel') return; e.preventDefault(); E.textDialog.close('default'); };
  E.messageDialog.addEventListener('close', function () { const editing = S.editingMessage; S.editingMessage = null; if (E.messageDialog.returnValue === 'default' && editing && E.messageInput.value.trim()) Promise.resolve(saveEditedMessage(editing, E.messageInput.value.trim())).catch(function (e) { toast(e.message, 'error'); }); }); $('#message-dialog-form').onsubmit = function (e) { if (e.submitter && e.submitter.value === 'cancel') return; e.preventDefault(); if (!E.messageInput.value.trim()) { toast(t('messageEmpty'), 'error'); return; } E.messageDialog.close('default'); };
  $('#manage-tags').onclick = function () { if (S.current) dialog({ kicker: t('organizeConversation'), title: t('editTags'), label: t('tags'), value: S.current.tags.join(', '), action: function (value) { return patchCurrent({ tags: value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) }, t('tagsUpdated')); } }); };
  E.detailsButton.onclick = function () { E.details.classList.add('open'); E.scrim.hidden = false; }; $('#close-details').onclick = function () { E.details.classList.remove('open'); E.scrim.hidden = true; }; $('#mobile-menu').onclick = function () { E.sidebar.classList.add('open'); E.scrim.hidden = false; }; $('#sidebar-close').onclick = closeSidebar; E.scrim.onclick = function () { E.sidebar.classList.remove('open'); E.details.classList.remove('open'); E.scrim.hidden = true; }; $('#back-to-list').onclick = function () { E.app.classList.remove('reading'); };
  $('#collapse-sidebar').onclick = function () { setPanelCollapsed('sidebar', true); };
  $('#collapse-list').onclick = function () { setPanelCollapsed('list', true); };
  document.querySelectorAll('[data-panel-action]').forEach(function (button) {
    button.onclick = function () {
      setPanelCollapsed(button.dataset.panelAction === 'show-sidebar' ? 'sidebar' : 'list', false);
    };
  });
  E.messages.onscroll = function () { $('#scroll-top').classList.toggle('visible', E.messages.scrollTop > 500); }; $('#scroll-top').onclick = function () { E.messages.scrollTo({ top: 0, behavior: 'smooth' }); }; E.messages.onclick = async function (e) { const editButton = e.target.closest('[data-edit-index]'); if (editButton) { editMessage(Number(editButton.dataset.editIndex)); return; } await handleRichContentClick(e, S.current, toast); }; $('#theme-toggle').onclick = function () { theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); };
  E.language.onchange = function () {
    setLanguage(E.language.value);
    renderSide();
    renderList();
    renderReader();
    if (E.storage.title) E.storage.textContent = t('connected');
  };
  document.onclick = function (e) { if (!e.target.closest('.popover') && !e.target.closest('#more-button') && !e.target.closest('#export-button') && !e.target.closest('#export-all-button')) hideMenus(); }; document.onkeydown = function (e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); E.search.focus(); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); E.importDialog.showModal(); } };
}
async function initialize() {
  const language = initI18n();
  E.language.innerHTML = LANGUAGE_OPTIONS.map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
  E.language.value = language;
  theme(localStorage.getItem('chatgpt-vault-theme') || 'light');
  restorePanelState();
  bind();
  try {
    const health = await api('/api/health');
    await refresh();
    E.storage.textContent = t('connected');
    E.storage.title = health.dataDirectory;
  } catch (error) {
    E.storage.textContent = t('connectionFailed');
    toast(`${t('connectionFailed')}: ${error.message}`, 'error');
  }
}
initialize();
