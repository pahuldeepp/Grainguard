import React, { useMemo, useState } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppRoot } from './src/AppRoot';
import { createServices, DEFAULT_MODE, DEMO_AVAILABLE } from './src/services';
import type { Mode } from './src/services';

export default function App() {
  const dark = useColorScheme() === 'dark';
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const services = useMemo(() => createServices(mode), [mode]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <AppRoot
        key={mode}
        services={services}
        onToggleMode={
          DEMO_AVAILABLE
            ? () => setMode(mode === 'demo' ? 'live' : 'demo')
            : undefined
        }
      />
    </SafeAreaProvider>
  );
}
