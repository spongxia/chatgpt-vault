import {
  extractAttachmentMarkers,
  isInternalToolMessage,
  renderConversationMessages,
  renderRichText
} from './renderer.js';
import { getLocale, t } from './i18n.js';

const PDF_PAGE_WIDTH_PX = 760;
const PDF_PAGE_TOP_PADDING_PX = 40;
const PDF_PAGE_BOTTOM_PADDING_PX = 44;
const PDF_ATOMIC_CONTENT_SELECTOR = '.katex, .math-block, .math-display';

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

export function findLargestFittingIndex(length, fits) {
  let low = 1;
  let high = Math.max(0, length);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
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

function buildPdfSurface(conversation, pageHeight) {
  const printable = printableConversationMessages(conversation.messages);
  const surface = document.createElement('div');
  surface.className = 'pdf-export-document';
  surface.setAttribute('aria-hidden', 'true');
  surface.style.setProperty('--pdf-page-height', `${pageHeight}px`);
  surface.style.setProperty('--pdf-page-top-padding', `${PDF_PAGE_TOP_PADDING_PX}px`);
  surface.style.setProperty('--pdf-page-bottom-padding', `${PDF_PAGE_BOTTOM_PADDING_PX}px`);

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
  document.body.append(surface);
  return {
    header,
    messages: [...body.children],
    surface
  };
}

async function renderSurfaceCanvas(surface) {
  if (typeof globalThis.html2canvas !== 'function') throw new Error(t('visualExporterUnavailable'));
  try {
    await document.fonts?.ready;
    const width = Math.ceil(surface.scrollWidth);
    const height = Math.ceil(surface.scrollHeight);
    const scale = calculateRasterScale(width, height);
    return globalThis.html2canvas(surface, {
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
  } finally {
    surface.remove();
  }
}

async function renderConversationCanvas(conversation) {
  return renderSurfaceCanvas(buildJpegSurface(conversation));
}

function createPdfPage(surface) {
  const page = document.createElement('section');
  page.className = 'pdf-export-page';
  const content = document.createElement('div');
  content.className = 'pdf-export-page-content';
  page.append(content);
  surface.append(page);
  return { content, page };
}

function pdfPageFits(pageState) {
  return pageState.content.scrollHeight <= pageState.content.clientHeight;
}

function createMessageSegment(message, continued = false) {
  const segment = message.cloneNode(false);
  segment.classList.add('pdf-message-segment');
  if (continued) segment.classList.add('continued');
  const label = message.querySelector('.pdf-message-label')?.cloneNode(true);
  const sourceBody = message.querySelector('.pdf-message-body');
  const body = sourceBody.cloneNode(false);
  if (label) segment.append(label);
  segment.append(body);
  return { body, element: segment };
}

function collectBlockBoundaries(root) {
  const boundaries = [{ node: root, offset: 0 }];
  if (root.matches?.(PDF_ATOMIC_CONTENT_SELECTOR)) {
    boundaries.push({ node: root, offset: root.childNodes.length });
    return boundaries;
  }

  const visit = parent => {
    [...parent.childNodes].forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        let offset = 0;
        for (const character of child.data) {
          offset += character.length;
          boundaries.push({ node: child, offset });
        }
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (!child.matches(PDF_ATOMIC_CONTENT_SELECTOR)) visit(child);
      boundaries.push({ node: parent, offset: index + 1 });
    });
  };
  visit(root);
  const end = boundaries.at(-1);
  if (end.node !== root || end.offset !== root.childNodes.length) {
    boundaries.push({ node: root, offset: root.childNodes.length });
  }
  return boundaries;
}

function cloneBlockRange(source, start, end) {
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const clone = source.cloneNode(false);
  clone.append(range.cloneContents());
  range.detach();
  return clone;
}

function startContinuedMessage(newPage, message) {
  const pageState = newPage();
  const segment = createMessageSegment(message, true);
  pageState.content.append(segment.element);
  return { pageState, segment };
}

function splitOversizedBlock(newPage, message, initialPageState, initialSegment, block) {
  const boundaries = collectBlockBoundaries(block);
  let boundaryIndex = 0;
  let pageState = initialPageState;
  let segment = initialSegment;

  while (boundaryIndex < boundaries.length - 1) {
    const remaining = boundaries.length - boundaryIndex - 1;
    const fittingCount = findLargestFittingIndex(remaining, count => {
      const candidate = cloneBlockRange(
        block,
        boundaries[boundaryIndex],
        boundaries[boundaryIndex + count]
      );
      segment.body.append(candidate);
      const fits = pdfPageFits(pageState);
      candidate.remove();
      return fits;
    });
    if (!fittingCount) throw new Error(t('exportFailedGeneric'));

    segment.body.append(cloneBlockRange(
      block,
      boundaries[boundaryIndex],
      boundaries[boundaryIndex + fittingCount]
    ));
    boundaryIndex += fittingCount;
    if (boundaryIndex < boundaries.length - 1) {
      ({ pageState, segment } = startContinuedMessage(newPage, message));
    }
  }
  return { pageState, segment };
}

function splitMessageAcrossPages(newPage, message, initialPageState) {
  let pageState = initialPageState;
  let segment = createMessageSegment(message);
  pageState.content.append(segment.element);
  const blocks = [...message.querySelector('.pdf-message-body').children];

  for (const block of blocks) {
    const candidate = block.cloneNode(true);
    const hadBlocks = segment.body.childElementCount > 0;
    segment.body.append(candidate);
    if (pdfPageFits(pageState)) continue;
    candidate.remove();

    if (hadBlocks) {
      ({ pageState, segment } = startContinuedMessage(newPage, message));
      segment.body.append(candidate);
      if (pdfPageFits(pageState)) continue;
      candidate.remove();
    } else {
      const hasPreviousContent = [...pageState.content.children]
        .some(child => child !== segment.element);
      if (hasPreviousContent) {
        segment.element.remove();
        ({ pageState, segment } = startContinuedMessage(newPage, message));
        segment.body.append(candidate);
        if (pdfPageFits(pageState)) continue;
        candidate.remove();
      }
    }

    ({ pageState, segment } = splitOversizedBlock(
      newPage,
      message,
      pageState,
      segment,
      block
    ));
  }
  return pageState;
}

function paginatePdfSurface(surface, header, messages) {
  const pages = [];
  const newPage = () => {
    const pageState = createPdfPage(surface);
    pages.push(pageState);
    return pageState;
  };
  let pageState = newPage();
  pageState.content.append(header.cloneNode(true));

  for (const message of messages) {
    const candidate = message.cloneNode(true);
    pageState.content.append(candidate);
    if (pdfPageFits(pageState)) continue;
    candidate.remove();

    if (message.classList.contains('assistant')) {
      pageState = splitMessageAcrossPages(newPage, message, pageState);
      continue;
    }

    pageState = newPage();
    pageState.content.append(candidate);
    if (pdfPageFits(pageState)) continue;
    candidate.remove();
    pageState = splitMessageAcrossPages(newPage, message, pageState);
  }

  const overflowingPage = pages.find(state => !pdfPageFits(state));
  if (overflowingPage) throw new Error(t('exportFailedGeneric'));
  return pages;
}

async function waitForStablePdfLayout() {
  await document.fonts?.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function renderPdfPageCanvas(page) {
  const width = Math.ceil(page.offsetWidth);
  const height = Math.ceil(page.offsetHeight);
  const scale = calculateRasterScale(width, height, {
    maxDimension: 8192,
    maxPixels: 20_000_000,
    preferredScale: 2
  });
  return globalThis.html2canvas(page, {
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
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('exportFailedGeneric'))), type, quality);
  });
}

export async function createConversationJpeg(conversation) {
  const canvas = await renderConversationCanvas(conversation);
  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

export async function createConversationPdf(conversation) {
  const JsPdf = globalThis.jspdf?.jsPDF;
  if (!JsPdf || typeof globalThis.html2canvas !== 'function') {
    throw new Error(t('visualExporterUnavailable'));
  }
  const pdf = new JsPdf({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;
  const pagePixelHeight = Math.round(PDF_PAGE_WIDTH_PX * contentHeight / contentWidth);
  const { header, messages, surface } = buildPdfSurface(conversation, pagePixelHeight);

  try {
    await waitForStablePdfLayout();
    const pages = paginatePdfSurface(surface, header, messages);
    await waitForStablePdfLayout();

    for (let index = 0; index < pages.length; index += 1) {
      if (index > 0) pdf.addPage();
      const canvas = await renderPdfPageCanvas(pages[index].page);
      pdf.addImage(
        canvas.toDataURL('image/jpeg', 0.92),
        'JPEG',
        margin,
        margin,
        contentWidth,
        contentHeight,
        undefined,
        'FAST'
      );
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    surface.remove();
  }

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
