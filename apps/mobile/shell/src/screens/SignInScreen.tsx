import React from 'react';
import { ScrollView, View } from 'react-native';
import { BrandMark, Button, Segmented, StatusLine, Txt, useTheme } from '../ui';

export function SignInScreen(props: {
  onSignIn: () => void;
  error: string | null;
  busy: boolean;
  mode: 'demo' | 'live';
  // This build has no sign-in endpoints: say so instead of failing on tap.
  unavailable?: boolean;
  // Present only in development builds, where demo data is available.
  onSelectMode?: (mode: 'demo' | 'live') => void;
  onCancel?: () => void;
}) {
  const { c } = useTheme();
  const live = props.mode === 'live';
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        padding: 24,
        justifyContent: 'flex-start',
        paddingTop: 72,
        gap: 24,
      }}
    >
      <View style={{ gap: 12 }}>
        <BrandMark size={44} />
        <Txt variant="title" accessibilityRole="header">
          GreenGuard
        </Txt>
        <Txt muted>
          See grain bin alerts and acknowledge them, even with a weak signal.
        </Txt>
      </View>
      {props.onSelectMode ? (
        <View style={{ gap: 4 }}>
          <Txt variant="meta" muted>
            Data source (development builds only)
          </Txt>
          <Segmented
            testIDPrefix="mode"
            value={props.mode}
            onChange={mode => !props.busy && props.onSelectMode?.(mode)}
            segments={[
              { key: 'demo', label: 'Demo data' },
              { key: 'live', label: 'Live' },
            ]}
          />
        </View>
      ) : null}
      {props.unavailable ? (
        <StatusLine
          testID="signin-unavailable"
          kind="stale"
          text="Sign-in is not configured for this build."
        />
      ) : null}
      {props.error ? (
        <StatusLine testID="signin-error" kind="error" text={props.error} />
      ) : null}
      <View style={{ gap: 12 }}>
        <Button
          testID="signin-button"
          label={live ? 'Sign in with browser' : 'Sign in to demo data'}
          busyLabel="Waiting for browser sign-in"
          busy={props.busy && live}
          disabled={(props.busy && !live) || props.unavailable}
          hint={
            live
              ? "Opens your organisation's sign-in page in the browser"
              : 'Signs in to fictional demo data'
          }
          onPress={props.onSignIn}
        />
        {props.busy && live ? (
          <View style={{ gap: 8 }}>
            <Txt muted accessibilityLiveRegion="polite">
              Waiting for browser sign-in... Finish there, then return here.
            </Txt>
            {props.onCancel ? (
              <Button
                testID="signin-cancel"
                label="Cancel sign-in"
                variant="secondary"
                onPress={props.onCancel}
              />
            ) : null}
          </View>
        ) : (
          <Txt variant="meta" style={{ color: c.textMuted }}>
            {live
              ? "You will sign in with your organisation's account."
              : 'Fictional data. Nothing is sent to a server.'}
          </Txt>
        )}
      </View>
    </ScrollView>
  );
}
