import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['.txt', '.md', '.docx', '.pdf']);
let pdfQueue = Promise.resolve();

function parsePdfSerially(parse, buffer) {
  const task = pdfQueue.then(() => parse(buffer));
  pdfQueue = task.catch(() => {});
  return task;
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
  let parser;
  // Import the library entry directly. pdf-parse 1.x's package entry runs a
  // debug fixture when loaded through ESM because `module.parent` is unset.
  try { parser = await import('pdf-parse/lib/pdf-parse.js'); } catch { throw new Error('PDF import support is not installed; run npm install'); }
  let result;
  const buffer = fs.readFileSync(file);
  try { result = await parsePdfSerially(parser.default || parser, buffer); }
  catch (e) {
    const structure = buffer.toString('latin1');
    if (/xref/i.test(String(e.message)) && structure.startsWith('%PDF-') && /\/Type\s*\/Page\b/.test(structure)) {
      throw new Error('PDF contains little or no selectable text; scanned PDFs need OCR before import');
    }
    throw new Error(`PDF could not be read: ${e.message}`);
  }
  const text = String(result.text || '').trim();
  if (text.length < 40) throw new Error('PDF contains little or no selectable text; scanned PDFs need OCR before import');
  return text;
}
