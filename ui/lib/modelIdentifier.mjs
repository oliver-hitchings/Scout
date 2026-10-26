// Exact hosted/local model IDs may have a namespace. This is an identifier,
// never a filesystem selector: reject absolute paths and traversal segments.
export function isSafeModelId(value) {
  return typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/.test(value);
}
