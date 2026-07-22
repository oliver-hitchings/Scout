export class BoundedUtf8Body {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('A non-negative byte limit is required');
    this.limit = limit;
    this.byteLength = 0;
    this.text = '';
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.finished = false;
  }

  append(chunk) {
    if (this.finished) throw new Error('Request body is already finished');
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    this.byteLength += bytes.byteLength;
    if (this.byteLength > this.limit) return { ok: false, reason: 'too-large', byteLength: this.byteLength };
    try {
      this.text += this.decoder.decode(bytes, { stream: true });
      return { ok: true, byteLength: this.byteLength };
    } catch {
      return { ok: false, reason: 'invalid-utf8', byteLength: this.byteLength };
    }
  }

  finish() {
    if (this.finished) throw new Error('Request body is already finished');
    this.finished = true;
    try {
      this.text += this.decoder.decode();
      return { ok: true, text: this.text, byteLength: this.byteLength };
    } catch {
      return { ok: false, reason: 'invalid-utf8', byteLength: this.byteLength };
    }
  }
}
