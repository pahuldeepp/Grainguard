// Hermes has no WebCrypto. The core's PKCE code needs SHA-256, secure random
// bytes, TextEncoder/TextDecoder and atob/btoa, so this module supplies them.
// Random bytes come only from crypto.getRandomValues, installed by
// react-native-get-random-values (native SecRandomCopyBytes) in index.js;
// there is deliberately no Math.random fallback for PKCE material.
import type { CryptoDeps } from '@greenguard/mobile-core';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

// FIPS 180-4 SHA-256. Small and dependency-free; verified against the standard
// vectors and the RFC 7636 PKCE vector in __tests__/polyfills.test.ts.
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    const extra = b < 0x80 ? 0 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
    let cp = extra === 0 ? b : b & (0x3f >> extra);
    for (let n = 0; n < extra; n++) cp = (cp << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function btoaFallback(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const n =
      (input.charCodeAt(i) << 16) |
      ((input.charCodeAt(i + 1) || 0) << 8) |
      (input.charCodeAt(i + 2) || 0);
    out +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < input.length ? B64[(n >> 6) & 63] : '=') +
      (i + 2 < input.length ? B64[n & 63] : '=');
  }
  return out;
}

function atobFallback(input: string): string {
  const clean = input.replace(/=+$/, '');
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) throw new Error('Invalid base64');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

// Install only what the runtime lacks; never replace a native implementation.
export function installPolyfills(): void {
  const g = globalThis as any;
  if (typeof g.TextEncoder !== 'function')
    g.TextEncoder = class {
      encode(text = '') {
        return utf8Encode(text);
      }
    };
  if (typeof g.TextDecoder !== 'function')
    g.TextDecoder = class {
      decode(bytes: Uint8Array) {
        return utf8Decode(bytes);
      }
    };
  if (typeof g.btoa !== 'function') g.btoa = btoaFallback;
  if (typeof g.atob !== 'function') g.atob = atobFallback;
  // The core's GraphqlClient uses AbortSignal.timeout, which React Native's
  // AbortController polyfill does not provide.
  if (
    typeof g.AbortSignal === 'function' &&
    typeof g.AbortSignal.timeout !== 'function' &&
    typeof g.AbortController === 'function'
  )
    g.AbortSignal.timeout = (ms: number) => {
      const controller = new g.AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };
}

export function shellCrypto(): CryptoDeps {
  const randomBytes = (length: number) => {
    const source = (globalThis as any).crypto;
    if (!source || typeof source.getRandomValues !== 'function')
      throw new Error('No secure random source (crypto.getRandomValues)');
    return source.getRandomValues(new Uint8Array(length)) as Uint8Array;
  };
  return {
    randomBytes,
    sha256: async data => sha256(data),
    randomUUID() {
      const b = randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
        16,
        20,
      )}-${h.slice(20)}`;
    },
  };
}
