import { challengeFor, base64Url } from '@greenguard/mobile-core';
import {
  installPolyfills,
  sha256,
  shellCrypto,
  utf8Decode,
  utf8Encode,
} from '../src/services/polyfills';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

type TestGlobals = {
  crypto?: { getRandomValues(array: Uint8Array): Uint8Array } | undefined;
  TextEncoder?: (new () => { encode(text?: string): Uint8Array }) | undefined;
  TextDecoder?: (new () => { decode(bytes: Uint8Array): string }) | undefined;
  atob?: ((input: string) => string) | undefined;
  btoa?: ((input: string) => string) | undefined;
  AbortSignal?: (typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }) | undefined;
};
const globals = () => globalThis as unknown as TestGlobals;

// Deterministic stand-in for react-native-get-random-values (native in the app).
function fakeRandom() {
  let counter = 1;
  globals().crypto = {
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = counter++ & 0xff;
      return array;
    },
  };
}

test('sha256 matches the FIPS 180-4 vectors including multi-block input', () => {
  expect(hex(sha256(new Uint8Array()))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  expect(hex(sha256(utf8Encode('abc')))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(
    hex(
      sha256(
        utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      ),
    ),
  ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  expect(hex(sha256(utf8Encode('a'.repeat(1000))))).toBe(
    '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
  );
});

test('PKCE challenge through the polyfilled path matches the RFC 7636 appendix B vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  fakeRandom();
  expect(await challengeFor(verifier, shellCrypto())).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('UTF-8 encoder and decoder round trip multi-byte characters', () => {
  const text = 'GreenGuard é 穀 🌾';
  expect(utf8Decode(utf8Encode(text))).toBe(text);
  expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
});

test('random bytes come from getRandomValues and fail closed without it', () => {
  fakeRandom();
  expect(Array.from(shellCrypto().randomBytes(3))).toEqual([1, 2, 3]);
  expect(shellCrypto().randomUUID()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  globals().crypto = undefined;
  expect(() => shellCrypto().randomBytes(4)).toThrow(/secure random/i);
});

test('installPolyfills fills missing text and base64 globals only', () => {
  const g = globals();
  const saved = {
    TextEncoder: g.TextEncoder,
    TextDecoder: g.TextDecoder,
    atob: g.atob,
    btoa: g.btoa,
  };
  g.TextEncoder = g.TextDecoder = g.atob = g.btoa = undefined;
  try {
    installPolyfills();
    const encoder = new g.TextEncoder!();
    expect(base64Url(encoder.encode('any carnal pleas'))).toBe(
      'YW55IGNhcm5hbCBwbGVhcw',
    );
    expect(new g.TextDecoder!().decode(encoder.encode('é'))).toBe('é');
    expect(g.atob!('Zm9v')).toBe('foo');
    const kept = () => 'kept';
    g.btoa = kept;
    installPolyfills();
    expect(g.btoa).toBe(kept);
  } finally {
    Object.assign(g, saved);
  }
});

test('AbortSignal.timeout is supplied when missing and aborts after the delay', () => {
  jest.useFakeTimers();
  const g = globals();
  const signalConstructor = g.AbortSignal as unknown as
    | { timeout?: (ms: number) => AbortSignal }
    | undefined;
  if (!signalConstructor) throw new Error('AbortSignal is unavailable in test');
  const saved = signalConstructor.timeout;
  signalConstructor.timeout = undefined;
  try {
    installPolyfills();
    const signal = signalConstructor.timeout!(50);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(60);
    expect(signal.aborted).toBe(true);
  } finally {
    signalConstructor.timeout = saved;
    jest.useRealTimers();
  }
});
