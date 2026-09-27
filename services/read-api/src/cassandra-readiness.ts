type ConnectableCassandra = {
  connect(): Promise<void>;
  getState(): { getConnectedHosts(): readonly unknown[] };
};

// A failed bootstrap must not leave readiness permanently false: the next probe
// starts a fresh connection attempt, while concurrent probes share one attempt.
export function createCassandraReadiness(
  client: ConnectableCassandra,
  onFailure: (error: unknown) => void,
) {
  let connecting: Promise<void> | undefined;
  const connected = () => client.getState().getConnectedHosts().length > 0;
  const ensureConnected = () => {
    if (connected() || connecting) return;
    connecting = client
      .connect()
      .catch(onFailure)
      .finally(() => {
        connecting = undefined;
      });
  };
  return { connected, ensureConnected };
}
