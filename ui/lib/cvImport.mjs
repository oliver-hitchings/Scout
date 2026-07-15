import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['.txt', '.md', '.docx', '.pdf']);
let pdfQueue = Promise.resolve();

function parsePdfSerially(PDFParse, buffer) {
  const task = pdfQueue.then(async () => {
    const parser = new PDFParse({ data: buffer });
    try {
      return await parser.getText();
    } finally {
      await parser.destroy();
    }
  });
  pdfQueue = task.catch(() => {});
  return task;
}

function unescapePdfLiteral(value) {
  return String(value || '')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\([nrtbf()\\])/g, (_, escaped) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escaped] || escaped));
}

// Keep a narrow fallback for small, valid Type 1 PDFs whose text stream is not
// compressed. It reads only literal strings used
// by PDF text-showing operators. Image-only/scanned PDFs have no such operators.
export function extractUncompressedPdfText(buffer) {
  const source = Buffer.from(buffer).toString('latin1');
  const streams = [...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((match) => match[1]);
  const text = [];
  for (const stream of streams) {
    for (const match of stream.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj\b/g)) text.push(unescapePdfLiteral(match[1]));
    for (const array of stream.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ\b/g)) {
      for (const match of array[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) text.push(unescapePdfLiteral(match[1]));
    }
  }
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

export async function extractCvText(file) {
  const ext = path.extname(file).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error('CV must be PDF, DOCX, Markdown, or text');
  if (!fs.existsSync(file)) throw new Error('CV file does not exist');
  if (ext === '.txt' || ext === '.md') return fs.readFileSync(file, 'utf8').trim();
  if (ext === '.docx') {
    let mammoth;
    try { mammoth = await import('mammoth'); } catch { throw new Error('DOCX import support is not installed; run npm install'); }
    const result = await mammoth.extractRawText({ path: file });
    const text = String(result.value || '').trim();
    if (!text) throw new Error('DOCX contained no readable text');
    return text;
  }
  let PDFParse;
  try { ({ PDFParse } = await import('pdf-parse')); } catch { throw new Error('PDF import support is not installed; run npm install'); }
  let result;
  const buffer = fs.readFileSync(file);
  try { result = await parsePdfSerially(PDFParse, buffer); }
  catch (e) {
    const fallback = extractUncompressedPdfText(buffer);
    if (fallback.length >= 40) return fallback;
    const structure = buffer.toString('latin1');
    if (/xref/i.test(String(e.message)) && structure.startsWith('%PDF-') && /\/Type\s*\/Page\b/.test(structure)) {
      throw new Error('PDF contains little or no selectable text; scanned PDFs need OCR before import');
    }
    throw new Error(`PDF could not be read: ${e.message}`);
  }
  const parsed = String(result.text || '').trim();
  const fallback = parsed.length < 40 ? extractUncompressedPdfText(buffer) : '';
  const text = parsed.length >= 40 ? parsed : fallback;
  if (text.length < 40) throw new Error('PDF contains little or no selectable text; scanned PDFs need OCR before import');
  return text;
}
