import { renderConversationMessages } from './renderer.js';
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

export function planPdfSlices(totalHeight, targetHeight, breakpoints = []) {
  const slices = [];
  const sorted = [...new Set(breakpoints.map(Math.round))]
    .filter(point => point > 0 && point < totalHeight)
    .sort((a, b) => a - b);
  let start = 0;
  while (start < totalHeight) {
    const idealEnd = Math.min(totalHeight, start + targetHeight);
    const minimumUsefulEnd = start + targetHeight * 0.45;
    const naturalEnd = [...sorted].reverse().find(point => point <= idealEnd && point >= minimumUsefulEnd);
    const end = idealEnd === totalHeight ? totalHeight : naturalEnd || idealEnd;
    slices.push({ start, end });
    start = end;
  }
  return slices;
}

function buildExportSurface(conversation) {
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

async function renderConversationCanvas(conversation) {
  if (typeof globalThis.html2canvas !== 'function') throw new Error(t('visualExporterUnavailable'));
  const surface = buildExportSurface(conversation);
  try {
    await document.fonts?.ready;
    const width = Math.ceil(surface.scrollWidth);
    const height = Math.ceil(surface.scrollHeight);
    const scale = calculateRasterScale(width, height);
    const surfaceRect = surface.getBoundingClientRect();
    const nodeBottoms = [...surface.querySelectorAll('.conversation-export-header, .message, .tool-card')]
      .map(node => node.getBoundingClientRect().bottom - surfaceRect.top);
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
      breakpoints: nodeBottoms.map(point => point * canvasScale)
    };
  } finally {
    surface.remove();
  }
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
  const { canvas, breakpoints } = await renderConversationCanvas(conversation);
  const pdf = new JsPdf({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 28;
  const footerHeight = 18;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2 - footerHeight;
  const pointsPerPixel = contentWidth / canvas.width;
  const targetSliceHeight = Math.floor(contentHeight / pointsPerPixel);
  const slices = planPdfSlices(canvas.height, targetSliceHeight, breakpoints);

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

  slices.forEach((_, index) => {
    pdf.setPage(index + 1);
    pdf.setFontSize(8);
    pdf.setTextColor(110, 118, 113);
    pdf.text(`${index + 1} / ${slices.length}`, pageWidth / 2, pageHeight - 13, { align: 'center' });
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
