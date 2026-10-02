import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User, UserManager } from "oidc-client-ts";
import { useNavigate } from "react-router";
import { App } from "./App";
import { Glyph, Loading } from "./ui";
import {
  applySessionChange,
  createAuthManager,
  currentAccessToken,
  returnPathFor,
  sessionIdFor,
  signOut,
} from "./auth";

const callbacks = new WeakMap<UserManager, Promise<User>>();
function completeCallback(manager: UserManager) {
  let callback = callbacks.get(manager);
  if (!callback) {
    callback = manager.signinRedirectCallback();
    callbacks.set(manager, callback);
  }
  return callback;
}

const silentCallbacks = new WeakMap<UserManager, Promise<void>>();
function completeSilentCallback(manager: UserManager) {
  let callback = silentCallbacks.get(manager);
  if (!callback) {
    callback = manager.signinSilentCallback();
    silentCallbacks.set(manager, callback);
  }
  return callback;
}

async function boundedSilentRestore(manager: UserManager): Promise<User | null> {
  try {
    return await Promise.race([
      manager.signinSilent(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
  } catch {
    return null;
  }
}

export function AuthGate() {
  const navigate = useNavigate();
  const manager = useMemo(createAuthManager, []);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const previousSession = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!manager) {
      setReady(true);
      return;
    }
    let active = true;
    const update = (next: User | null) => {
      if (!active) return;
      const nextId = next && !next.expired ? sessionIdFor(next) : undefined;
      applySessionChange(previousSession.current, nextId);
      previousSession.current = nextId;
      setSessionId(nextId);
      setUser(next && !next.expired ? next : null);
    };
    manager.events.addUserLoaded(update);
    const unload = () => update(null);
    const renew = () => {
      void manager.signinSilent().then(update).catch(unload);
    };
    manager.events.addUserUnloaded(unload);
    manager.events.addUserSignedOut(unload);
    manager.events.addAccessTokenExpired(renew);
    const initialize = async () => {
      try {
        if (window.location.pathname === "/auth/silent-callback") {
          await Promise.race([
            completeSilentCallback(manager),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);
          if (active) setReady(true);
          return;
        }
        let next = window.location.pathname === "/auth/callback"
          ? await completeCallback(manager)
          : await manager.getUser();
        // Tokens stay in memory. On a full reload, recover the session through
        // the IdP's existing browser session instead of persisting credentials.
        if (!next || next.expired) {
          next = await boundedSilentRestore(manager);
        }
        update(next);
        if (window.location.pathname === "/auth/callback") {
          navigate(returnPathFor(next?.state), { replace: true });
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sign-in failed.");
      } finally {
        if (active) setReady(true);
      }
    };
    void initialize();
    return () => {
      active = false;
      manager.events.removeUserLoaded(update);
      manager.events.removeUserUnloaded(unload);
      manager.events.removeUserSignedOut(unload);
      manager.events.removeAccessTokenExpired(renew);
    };
  }, [manager, navigate]);

  const getAccessToken = useCallback(
    async () => (manager ? currentAccessToken(manager) : null),
    [manager],
  );
  if (!ready)
    return (
      <main className="gate">
        <div className="gate-card">
          <Loading label="Restoring sign-in…" rows={1} />
        </div>
      </main>
    );
  if (!manager) return <App />;
  if (!user || !sessionId)
    return (
      <main className="gate">
        <div className="gate-card">
          <p className="brand">GreenGuard</p>
          <h1>Sign in</h1>
          <p className="lede">Sign in to access your workspace.</p>
          {error && (
            <p role="alert" className="field-error">
              <Glyph name="critical" />
              <span>{error}</span>
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void manager.signinRedirect({
                state: {
                  returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
                },
                nonce: crypto.randomUUID(),
              })
            }
          >
            Sign in
          </button>
        </div>
      </main>
    );
  return (
    <App
      getAccessToken={getAccessToken}
      sessionId={sessionId}
      onSignOut={() => {
        previousSession.current = undefined;
        setUser(null);
        setSessionId(undefined);
        void signOut(manager);
      }}
    />
  );
}
