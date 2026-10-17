const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
export async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, typeof message === 'string' ? enc.encode(message) : message));
}
/** Constant-time comparison of two hex strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Canonical message the desktop app signs: timestamp, nonce and body digest, newline separated. */
export const signingMessage = async (ts, nonce, bodyBytes) => `${ts}\n${nonce}\n${await sha256Hex(bodyBytes)}`;

export const hexToBytes = h => { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return out; };
/** Verifies an Ed25519 signature (hex) over a UTF-8 message with a raw 32-byte public key (hex). */
export async function verifyEd25519(publicKeyHex, signatureHex, message) {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signatureHex), enc.encode(message));
  } catch { return false; }
}
/** Number of leading zero bits of a hex digest. */
export function leadingZeroBits(hexDigest) {
  let bits = 0;
  for (const c of hexDigest) { const v = parseInt(c, 16); if (v === 0) { bits += 4; continue; } return bits + Math.clz32(v) - 28; }
  return bits;
}
/** Proof-of-work preimage. The public key is bound in, so a solution cannot be reused for another key. */
export const powMessage = (challenge, publicKeyHex, counter) => `strata-arena-pow|${challenge}|${publicKeyHex}|${counter}`;
