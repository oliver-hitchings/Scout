import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedUtf8Body } from './requestBody.mjs';

test('bounded request decoding preserves UTF-8 split across transport chunks', () => {
  const source = Buffer.from('{"text":"café 気候"}');
  const splitInsideAccent = source.indexOf(Buffer.from('é')) + 1;
  const body = new BoundedUtf8Body(source.length);
  assert.equal(body.append(source.subarray(0, splitInsideAccent)).ok, true);
  assert.equal(body.append(source.subarray(splitInsideAccent)).ok, true);
  assert.deepEqual(body.finish(), { ok: true, text: source.toString('utf8'), byteLength: source.length });
});

test('bounded request decoding counts bytes rather than JavaScript characters', () => {
  const body = new BoundedUtf8Body(1);
  assert.deepEqual(body.append(Buffer.from('é')), { ok: false, reason: 'too-large', byteLength: 2 });
});

test('bounded request decoding rejects malformed or incomplete UTF-8', () => {
  const malformed = new BoundedUtf8Body(10);
  assert.equal(malformed.append(Buffer.from([0xc3, 0x28])).reason, 'invalid-utf8');
  const incomplete = new BoundedUtf8Body(10);
  assert.equal(incomplete.append(Buffer.from([0xe2, 0x82])).ok, true);
  assert.equal(incomplete.finish().reason, 'invalid-utf8');
});
