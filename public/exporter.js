import {
  extractAttachmentMarkers,
  isInternalToolMessage,
  renderConversationMessages,
  renderRichText
} from './renderer.js';
import { getLocale, t } from './i18n.js';

export function safeDownloadName(value, fallback = 'conversation') {
  const cleaned = String(value || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

export function calculateRasterScale(width, height, options = {}) {
  const preferred = options.preferredScale || 2;
  const maxDimension = options.maxDimension || 30000;
  const maxPixels = options.maxPixels || 64_000_000;
  return Math.min(
    preferred,
    maxDimension / Math.max(1, width),
    maxDimension / Math.max(1, height),
    Math.sqrt(maxPixels / Math.max(1, width * height))
  );
}

export function planPdfSlices(totalHeight, targetHeight, breakpoints = [], options = {}) {
  const slices = [];
  const minimumUsefulRatio = options.minimumUsefulRatio ?? 0.72;
  const protectedRanges = (options.protectedRanges || [])
    .map(range => ({ start: Math.round(range.start), end: Math.round(range.end) }))
    .filter(range => range.end > range.start && range.start >= 0 && range.end <= totalHeight)
    .sort((a, b) => a.start - b.start);
  const unbreakableRanges = protectedRanges
    .filter(range => range.end - range.start <= targetHeight);
  const sorted = [...new Set([
    ...breakpoints.map(Math.round),
    ...unbreakableRanges.map(range => range.start)
  ])]
    .filter(point => point > 0 && point < totalHeight)
    .sort((a, b) => a - b);
  const isProtectedPoint = point => unbreakableRanges
    .some(range => point > range.start && point < range.end);
  let start = 0;
  while (start < totalHeight) {
    const idealEnd = Math.min(totalHeight, start + targetHeight);
    const minimumUsefulEnd = start + targetHeight * minimumUsefulRatio;
    const naturalEnd = [...sorted].reverse().find(point =>
      point <= idealEnd &&
      point >= minimumUsefulEnd &&
      !isProtectedPoint(point)
    );
    let end = idealEnd === totalHeight
      ? totalHeight
      : naturalEnd || idealEnd;
    const containingRange = unbreakableRanges.find(range =>
      end > range.start &&
      end < range.end &&
      range.start > start
    );
    if (containingRange) end = containingRange.start;
    slices.push({ start, end });
    start = end;
  }
  return slices;
}

export function cleanDocumentContent(content) {
  const extracted = extractAttachmentMarkers(content);
  return extracted.text
    .replace(/(?:cite|filecite)[^]+/g, '')
    .replace(/i[^]+/g, '')
    .replace(/\[[^\]\n]+\]\((?:sandbox|sediment):[^)]+\)/gi, '')
    .replace(/(?:sandbox|sediment):\/\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function printableConversationMessages(messages = []) {
  const printable = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!['user', 'assistant'].includes(message?.role)) continue;
    if (isInternalToolMessage(message, messages[index + 1])) continue;
    const content = cleanDocumentContent(message.content);
    if (!content) continue;
    printable.push({ ...message, content });
  }
  return printable;
}

function buildJpegSurface(conversation) {
  const surface = document.createElement('section');
  surface.className = 'conversation-export-surface';
  surface.setAttribute('aria-hidden', 'true');

  const header = document.createElement('header');
  header.className = 'conversation-export-header';
  const kicker = document.createElement('span');
  kicker.textContent = 'ChatGPT Vault';
  const title = document.createElement('h1');
  title.textContent = conversation.title;
  const meta = document.createElement('p');
  const created = new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(conversation.createdAt));
  meta.textContent = `${created} · ${t('chats', { count: conversation.messages?.length || 0 })} · ${conversation.source}`;
  header.append(kicker, title, meta);

  const messages = document.createElement('div');
  messages.className = 'conversation-export-messages';
  messages.innerHTML = renderConversationMessages(conversation);
  surface.append(header, messages);
  document.body.append(surface);
  return surface;
}

function buildPdfSurface(conversation) {
  const printable = printableConversationMessages(conversation.messages);
  const surface = document.createElement('article');
  surface.className = 'pdf-export-document';
  surface.setAttribute('aria-hidden', 'true');

  const header = document.createElement('header');
  header.className = 'pdf-export-header';
  const kicker = document.createElement('span');
  kicker.textContent = 'CHATGPT VAULT';
  const title = document.createElement('h1');
  title.textContent = conversation.title;
  const meta = document.createElement('p');
  const created = new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date(conversation.createdAt));
  meta.textContent = `${created} · ${t('chats', { count: printable.length })}`;
  header.append(kicker, title, meta);

  const body = document.createElement('div');
  body.className = 'pdf-export-body';
  body.innerHTML = printable.map((message, index) => {
    const sender = message.role === 'user' ? t('userName') : 'ChatGPT';
    const rendered = renderRichText(message.content, new Map(), index);
    return `<section class="pdf-message ${message.role}">
      <div class="pdf-message-label"><span></span><strong>${sender}</strong></div>
      <div class="message-body pdf-message-body">${rendered.html}</div>
    </section>`;
  }).join('');
  surface.append(header, body);
  document.body.append(surface);
  return surface;
}

async function renderSurfaceCanvas(surface, breakpointSelector, options = {}) {
  if (typeof globalThis.html2canvas !== 'function') throw new Error(t('visualExporterUnavailable'));
  try {
    await document.fonts?.ready;
    const width = Math.ceil(surface.scrollWidth);
    const height = Math.ceil(surface.scrollHeight);
    const scale = calculateRasterScale(width, height);
    const surfaceRect = surface.getBoundingClientRect();
    const nodes = [...surface.querySelectorAll(breakpointSelector)];
    const nodeBottoms = nodes
      .map(node => node.getBoundingClientRect().bottom - surfaceRect.top);
    const startNodes = options.startSelector
      ? [...surface.querySelectorAll(options.startSelector)]
      : options.includeStarts ? nodes : [];
    const nodeTops = startNodes
      .map(node => node.getBoundingClientRect().top - surfaceRect.top);
    const nodeRanges = options.includeRanges
      ? nodes
        .filter(node => !options.rangeFilter || options.rangeFilter(node))
        .map(node => ({
          start: node.getBoundingClientRect().top - surfaceRect.top,
          end: node.getBoundingClientRect().bottom - surfaceRect.top
        }))
      : [];
    const textLineBottoms = options.lineSelector
      ? [...surface.querySelectorAll(options.lineSelector)].flatMap(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const bottoms = [...range.getClientRects()]
          .map(rect => rect.bottom - surfaceRect.top + (options.lineSafetyOffset || 0));
        range.detach();
        return bottoms;
      })
      : [];
    const canvas = await globalThis.html2canvas(surface, {
      backgroundColor: '#ffffff',
      scale,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
      logging: false,
      useCORS: true
    });
    const canvasScale = canvas.height / height;
    return {
      canvas,
      breakpoints: [...nodeBottoms, ...nodeTops, ...textLineBottoms]
        .filter(point => point > 0 && point < height)
        .map(point => point * canvasScale),
      protectedRanges: nodeRanges.map(range => ({
        start: range.start * canvasScale,
        end: range.end * canvasScale
      }))
    };
  } finally {
    surface.remove();
  }
}

async function renderConversationCanvas(conversation) {
  return renderSurfaceCanvas(
    buildJpegSurface(conversation),
    '.conversation-export-header, .message, .tool-card'
  );
}

async function renderPdfCanvas(conversation) {
  return renderSurfaceCanvas(
    buildPdfSurface(conversation),
    [
      '.pdf-message',
      '.pdf-message-body > *',
      '.pdf-message-body li',
      '.pdf-message-body tr',
      '.pdf-message.user',
      '.pdf-message-body .math-block',
      '.pdf-message-body .math-display',
      '.pdf-message-body table',
      '.pdf-message-body .code-block',
      '.pdf-message-body blockquote'
    ].join(', '),
    {
      includeRanges: true,
      startSelector: '.pdf-message-body h1, .pdf-message-body h2, .pdf-message-body h3, .pdf-message-body h4',
      lineSelector: '.pdf-message-body p, .pdf-message-body li',
      lineSafetyOffset: 4,
      rangeFilter: node =>
        node.matches('.pdf-message.user, .math-block, .math-display, table, .code-block, blockquote')
    }
  );
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('exportFailedGeneric'))), type, quality);
  });
}

export async function createConversationJpeg(conversation) {
  const { canvas } = await renderConversationCanvas(conversation);
  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

export async function createConversationPdf(conversation) {
  const JsPdf = globalThis.jspdf?.jsPDF;
  if (!JsPdf) throw new Error(t('visualExporterUnavailable'));
  const { canvas, breakpoints, protectedRanges } = await renderPdfCanvas(conversation);
  const pdf = new JsPdf({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const bottomSafety = 28;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2 - bottomSafety;
  const pointsPerPixel = contentWidth / canvas.width;
  const targetSliceHeight = Math.floor(contentHeight / pointsPerPixel);
  const slices = planPdfSlices(canvas.height, targetSliceHeight, breakpoints, {
    protectedRanges,
    minimumUsefulRatio: 0.56
  });

  slices.forEach((slice, index) => {
    if (index > 0) pdf.addPage();
    const sliceHeight = slice.end - slice.start;
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const context = pageCanvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(canvas, 0, slice.start, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
    pdf.addImage(
      pageCanvas.toDataURL('image/jpeg', 0.92),
      'JPEG',
      margin,
      margin,
      contentWidth,
      sliceHeight * pointsPerPixel,
      undefined,
      'FAST'
    );
  });

  pdf.setProperties({
    title: conversation.title,
    subject: 'ChatGPT Vault conversation export',
    creator: 'ChatGPT Vault'
  });
  return pdf.output('blob');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
