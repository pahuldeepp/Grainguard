import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertFilter } from './ui';
import { Pressable, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AlertView, Identity, QueuedAck } from '@greenguard/mobile-core';
import type { AppServices } from './services/types';
import { AlertDetailScreen } from './screens/AlertDetailScreen';
import { AlertListScreen } from './screens/AlertListScreen';
import { QueueScreen } from './screens/QueueScreen';
import { SignInScreen } from './screens/SignInScreen';
import {
  Button,
  LinkButton,
  ListSkeleton,
  StatusLine,
  BrandMark,
  Glyph,
  triggerText,
  Txt,
  alertLabel,
  nextOpenAlert,
  announce,
  binTitle,
  useTheme,
} from './ui';

type Route =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'queue' };

export const IDENTITY_TIMEOUT_MS = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function AppRoot(props: {
  services: AppServices;
  // Dev only: lets the "Demo data" label switch between demo and live mode.
  onToggleMode?: () => void;
}) {
  const { services } = props;
  const { c } = useTheme();
  const [identity, setIdentity] = useState<Identity | null | undefined>(
    undefined,
  );
  const [online, setOnline] = useState(services.connectivity.isOnline());
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [pending, setPending] = useState<QueuedAck[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<AlertFilter>('open');
  const scrollY = useRef(0);
  const [ackBusy, setAckBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityRef = useRef<Identity | null>(null);
  identityRef.current = identity ?? null;

  const refreshPending = useCallback(
    async (id: Identity) => {
      const entries = await services.queue.pending(id);
      if (identityRef.current === id) setPending(entries);
    },
    [services],
  );

  const loadAlerts = useCallback(
    async (id: Identity) => {
      setLoading(true);
      try {
        const page = await services.alerts.list();
        if (identityRef.current === id) {
          setAlerts(page.items);
          setHasMore(page.nextCursor !== null);
          setError(null);
        }
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    },
    [services],
  );

  const sync = useCallback(
    async (id: Identity) => {
      const result = await services.queue.drain(id);
      await refreshPending(id);
      if (result.sent.length + result.alreadyAcknowledged.length > 0)
        await loadAlerts(id);
      if (timer.current) clearTimeout(timer.current);
      if (result.status === 'backoff' && result.nextAttemptAt)
        timer.current = setTimeout(
          () => void sync(id),
          Math.max(0, result.nextAttemptAt - Date.now()),
        );
    },
    [services, refreshPending, loadAlerts],
  );

  useEffect(() => {
    // Never leave the app on a skeleton: a failed or stuck identity lookup
    // (for example an unconfigured release build) resolves to signed out.
    let live = true;
    const timeout = setTimeout(
      () => live && setIdentity(null),
      IDENTITY_TIMEOUT_MS,
    );
    services.session
      .identity()
      .catch(error => {
        if (live) setSignInError(messageOf(error));
        return null;
      })
      .then(id => {
        if (!live) return;
        clearTimeout(timeout);
        setIdentity(id);
      });
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [services]);

  useEffect(() => {
    if (!identity) return;
    void loadAlerts(identity);
    void sync(identity);
  }, [identity, loadAlerts, sync]);

  useEffect(
    () =>
      services.connectivity.subscribe(next => {
        setOnline(next);
        const id = identityRef.current;
        if (id)
          announce(
            next
              ? 'Back online.'
              : 'Offline. Acknowledgements will send when you reconnect.',
          );
        if (next && id) {
          void sync(id);
          void loadAlerts(id);
        }
      }),
    [services, sync, loadAlerts],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const run = async (
    work: () => Promise<void>,
    onError: (m: string) => void,
  ) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      setSignInError(null);
      await services.session.signIn();
      setIdentity(await services.session.identity());
    }, setSignInError);

  const signOut = () =>
    run(async () => {
      await services.session.signOut();
      setIdentity(null);
      setAlerts([]);
      setPending([]);
      setLoaded(false);
      scrollY.current = 0;
      setRoute({ name: 'list' });
    }, setError);

  const switchTenant = () =>
    run(async () => {
      setAlerts([]);
      setPending([]);
      setLoaded(false);
      scrollY.current = 0;
      setRoute({ name: 'list' });
      services.alerts.clearCache();
      await services.session.switchTenant();
      setIdentity(await services.session.identity());
    }, setError);

  const acknowledge = async (alert: AlertView) => {
    if (!identity || ackBusy) return;
    setAckBusy(true);
    setFeedback(null);
    try {
      const result = await services.queue.submit(
        identity,
        alert.alertId,
        alert.version,
      );
      await refreshPending(identity);
      const done = result.sent.length + result.alreadyAcknowledged.length > 0;
      if (done) await loadAlerts(identity);
      if (done) setFeedback('Acknowledged.');
      else announce('Saved. It will send when you reconnect.');
    } finally {
      setAckBusy(false);
    }
  };

  const pendingCount = pending.filter(p => !p.rejectedReason).length;
  const rejectedCount = pending.length - pendingCount;
  const describeAlert = (alertId: string) => {
    const a = alerts.find(x => x.alertId === alertId);
    if (!a) return alertLabel(alertId);
    const where = services.describeBin(a.binId);
    return binTitle(where.bin, a.binId);
  };

  const pendingIds = new Set(
    pending.filter(p => !p.rejectedReason).map(p => p.alertId),
  );
  const openNext = (from: AlertView) => {
    const next = nextOpenAlert(alerts, pendingIds, from.alertId);
    if (!next) return undefined;
    return () => {
      setFeedback(null);
      setRoute({ name: 'detail', id: next.alertId });
    };
  };

  const unsentTotal = pendingCount + rejectedCount;
  const header =
    identity && route.name === 'list' ? (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingLeft: 16,
          paddingRight: 8,
          paddingVertical: 4,
          minHeight: 52,
        }}
      >
        <BrandMark />
        <View style={{ flex: 1 }}>
          <Txt variant="section" accessibilityRole="header" numberOfLines={2}>
            {(services.session.tenantName
              ? services.session.tenantName(identity)
              : 'Alerts'
            ).replace(/-/g, '\u2011')}
          </Txt>
        </View>
        <Pressable
          testID="queue-button"
          accessibilityRole="button"
          accessibilityLabel={`Sync queue, ${pendingCount} unsent, ${rejectedCount} rejected`}
          onPress={() => setRoute({ name: 'queue' })}
          style={{
            minHeight: 44,
            minWidth: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingHorizontal: 8,
          }}
        >
          {unsentTotal > 0 ? (
            <Glyph kind={rejectedCount > 0 ? 'critical' : 'unsent'} size={18} />
          ) : null}
          <Txt
            variant="meta"
            muted={unsentTotal === 0}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {pendingCount + rejectedCount === 0
              ? 'Synced'
              : `${pendingCount + rejectedCount} unsent`}
          </Txt>
        </Pressable>
      </View>
    ) : null;

  const footer = identity ? (
    <View style={{ paddingTop: 24, paddingBottom: 32 }}>
      <View
        style={{
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: c.line,
          paddingHorizontal: 16,
        }}
      >
        <View
          style={{
            alignItems: 'flex-start',
            borderBottomWidth: 1,
            borderColor: c.line,
            width: '100%',
          }}
        >
          <LinkButton
            testID="switch-tenant"
            label="Switch organisation"
            tone="plain"
            disabled={busy}
            onPress={switchTenant}
          />
        </View>
        <View style={{ alignItems: 'flex-start' }}>
          <LinkButton
            testID="sign-out"
            label="Sign out"
            tone="critical"
            disabled={busy}
            onPress={signOut}
          />
        </View>
      </View>
      {services.mode === 'demo' ? (
        <View style={{ padding: 16, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {services.simulateOffline ? (
              <Switch
                testID="offline-switch"
                accessibilityLabel="Simulate offline"
                value={services.isSimulatedOffline?.() ?? false}
                onValueChange={value => services.simulateOffline?.(value)}
              />
            ) : null}
            <Txt variant="meta" muted style={{ flexShrink: 1 }}>
              Simulate offline (demo)
            </Txt>
          </View>
          {props.onToggleMode ? (
            <View style={{ alignItems: 'flex-start' }}>
              <LinkButton
                testID="demo-badge"
                label="Switch to live sign-in"
                tone="plain"
                accessibilityLabel="Demo data. Switch to live mode."
                onPress={props.onToggleMode}
              />
            </View>
          ) : null}
        </View>
      ) : props.onToggleMode ? (
        <View style={{ padding: 16, alignItems: 'flex-start' }}>
          <LinkButton
            testID="live-badge"
            label="Switch to demo data"
            tone="plain"
            accessibilityLabel="Live mode. Switch to demo data."
            onPress={props.onToggleMode}
          />
        </View>
      ) : null}
    </View>
  ) : null;

  let body: React.ReactNode;
  if (identity === undefined) {
    body = <ListSkeleton rows={3} />;
  } else if (identity === null) {
    body = (
      <SignInScreen
        onSignIn={signIn}
        error={signInError}
        busy={busy}
        mode={services.mode}
        unavailable={services.signInAvailable === false}
        onSelectMode={
          props.onToggleMode
            ? mode => {
                if (mode !== services.mode) props.onToggleMode?.();
              }
            : undefined
        }
        onCancel={services.session.cancelSignIn}
      />
    );
  } else if (route.name === 'queue') {
    body = (
      <QueueScreen
        entries={pending}
        describe={describeAlert}
        now={Date.now()}
        online={online}
        onBack={() => setRoute({ name: 'list' })}
        onRetry={() => void sync(identity)}
        onDismiss={entry =>
          void services.queue
            .dismiss(identity, entry.idempotencyKey)
            .then(() => refreshPending(identity))
        }
      />
    );
  } else if (route.name === 'detail') {
    const alert = alerts.find(a => a.alertId === route.id);
    body = alert ? (
      <AlertDetailScreen
        alert={alert}
        pending={pending.find(p => p.alertId === alert.alertId)}
        now={Date.now()}
        online={online}
        where={services.describeBin(alert.binId)}
        busy={ackBusy}
        feedback={feedback}
        onNext={openNext(alert)}
        timeline={services.timeline?.(alert.alertId)}
        readings={services.readings?.(alert.alertId)}
        demo={services.mode === 'demo'}
        you={identity.subject}
        onAcknowledge={() => void acknowledge(alert)}
        onBack={() => {
          setFeedback(null);
          setRoute({ name: 'list' });
        }}
      />
    ) : (
      <View style={{ padding: 16 }}>
        <Button
          label="Alert not found. Back to alerts"
          variant="secondary"
          onPress={() => setRoute({ name: 'list' })}
        />
      </View>
    );
  } else {
    body = (
      <AlertListScreen
        alerts={alerts}
        pending={pending}
        loading={loading}
        loaded={loaded}
        hasMore={hasMore}
        filter={filter}
        onFilter={setFilter}
        initialOffset={scrollY.current}
        onScrollOffset={y => {
          scrollY.current = y;
        }}
        error={error}
        footer={footer}
        now={Date.now()}
        describeBin={services.describeBin}
        readingFor={id => {
          const r = services.readings?.(id);
          return r ? triggerText(r) : undefined;
        }}
        onOpen={a => {
          setFeedback(null);
          setRoute({ name: 'detail', id: a.alertId });
        }}
        onRefresh={() => void loadAlerts(identity)}
      />
    );
  }

  const statusLine = identity ? (
    !online ? (
      <StatusLine
        testID="offline-banner"
        kind="offline"
        text={`Offline${services.mode === 'demo' ? ', demo data' : ''}. ${
          pendingCount > 0
            ? `${pendingCount} acknowledgement${
                pendingCount === 1 ? '' : 's'
              } will send when you reconnect.`
            : 'Alerts may be out of date.'
        }`}
        actionHint="Opens the sync queue"
        onPress={() => setRoute({ name: 'queue' })}
      />
    ) : error && alerts.length > 0 ? (
      <StatusLine
        testID="stale-banner"
        kind="stale"
        text="Could not refresh. Showing the last loaded alerts. Tap to retry."
        onPress={() => void loadAlerts(identity)}
      />
    ) : services.mode === 'demo' ? (
      <StatusLine
        testID="demo-banner"
        kind="demo"
        text={`Demo data, fictional${
          unsentTotal > 0 ? `. ${unsentTotal} unsent` : ''
        }`}
        onPress={
          unsentTotal > 0 ? () => setRoute({ name: 'queue' }) : undefined
        }
      />
    ) : null
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 720,
          alignSelf: 'center',
        }}
      >
        {header}
        {statusLine}
        <View style={{ flex: 1 }}>{body}</View>
      </View>
    </SafeAreaView>
  );
}
