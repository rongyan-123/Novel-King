import { parentPort, workerData } from 'node:worker_threads';
import { readZip } from './zip-reader.mjs';
try {
  const original = Buffer.from(workerData.original);
  let text = '';
  if (workerData.extension === '.docx') {
    readZip(original); // Reuse the existing archive size, path and decompression guards.
    const { default: mammoth } = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: original })).value;
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(original), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
    const document = await loading.promise;
    const pages = [];
    for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex++) {
      const page = await document.getPage(pageIndex);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
      page.cleanup();
    }
    text = pages.join('\n\n');
    await loading.destroy();
  }
  parentPort.postMessage({ text, read_status: text.trim() ? 'ready' : 'original', read_error: text.trim() ? '' : '未提取到文字；扫描件请另上传文字版，原件已保留' });
} catch (error) {
  parentPort.postMessage({ text: '', read_status: 'error', read_error: `文本提取失败：${String(error.message).slice(0, 240)}。原件已保留` });
}
