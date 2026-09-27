import { waitForCallback } from '../src/services/callback';

const REDIRECT = 'greenguard://auth/callback';

function source() {
  const listeners = new Set<(event: { url: string }) => void>();
  return {
    listeners,
    emit: (url: string) => listeners.forEach(l => l({ url })),
    addEventListener: (_: 'url', l: (event: { url: string }) => void) => {
      listeners.add(l);
      return { remove: () => void listeners.delete(l) };
    },
  };
}

test('resolves with the redirect URL, ignores other URLs and removes the listener', async () => {
  const linking = source();
  const wait = waitForCallback(linking, REDIRECT, 1000);
  linking.emit('greenguard://other/path?code=x');
  linking.emit('https://evil.example/?code=x');
  expect(linking.listeners.size).toBe(1);
  linking.emit(`${REDIRECT}?code=c&state=s`);
  await expect(wait.promise).resolves.toBe(`${REDIRECT}?code=c&state=s`);
  expect(linking.listeners.size).toBe(0);
});

test('cancel rejects and removes the listener', async () => {
  const linking = source();
  const wait = waitForCallback(linking, REDIRECT, 1000);
  wait.cancel();
  await expect(wait.promise).rejects.toThrow('Sign-in cancelled');
  expect(linking.listeners.size).toBe(0);
});

test('times out when the browser never returns', async () => {
  jest.useFakeTimers();
  try {
    const linking = source();
    const wait = waitForCallback(linking, REDIRECT, 500);
    const assertion = expect(wait.promise).rejects.toThrow('timed out');
    jest.advanceTimersByTime(501);
    await assertion;
    expect(linking.listeners.size).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
