// Waits for the OIDC redirect (greenguard://auth/callback?...) delivered through
// React Native Linking. Unrelated URLs are ignored, a browser the user closes
// without finishing times out or is cancelled, and the listener is always removed.
export interface UrlSource {
  addEventListener(
    type: 'url',
    listener: (event: { url: string }) => void,
  ): { remove(): void };
}

export interface CallbackWait {
  promise: Promise<string>;
  cancel(): void;
}

export const CALLBACK_TIMEOUT_MS = 3 * 60_000;

export function isExpectedRedirect(candidate: string, redirectUri: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(redirectUri);
    return (
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      actual.pathname === expected.pathname &&
      actual.username === expected.username &&
      actual.password === expected.password &&
      actual.hash === ''
    );
  } catch {
    return false;
  }
}

export async function consumeInitialCallback(
  linking: { getInitialURL(): Promise<string | null | undefined> },
  redirectUri: string,
  complete: (url: string) => Promise<unknown>,
): Promise<boolean> {
  const initialUrl = await linking.getInitialURL();
  if (!initialUrl || !isExpectedRedirect(initialUrl, redirectUri)) return false;
  await complete(initialUrl);
  return true;
}

export function waitForCallback(
  linking: UrlSource,
  redirectUri: string,
  timeoutMs: number = CALLBACK_TIMEOUT_MS,
): CallbackWait {
  let finish!: (result: { url?: string; error?: Error }) => void;
  const promise = new Promise<string>((resolve, reject) => {
    let done = false;
    const subscription = linking.addEventListener('url', event => {
      if (isExpectedRedirect(event.url, redirectUri)) end({ url: event.url });
    });
    const timer = setTimeout(
      () => end({ error: new Error('Sign-in timed out. Try again.') }),
      timeoutMs,
    );
    function end(result: { url?: string; error?: Error }) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription.remove();
      if (result.url) resolve(result.url);
      else reject(result.error);
    }
    finish = end;
  });
  return {
    promise,
    cancel: () => finish({ error: new Error('Sign-in cancelled') }),
  };
}
