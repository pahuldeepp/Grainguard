// Prometheus exporter for state that Kafka Connect and Schema Registry expose only over REST.
// Dependency-free (Node built-ins). Metrics use bounded labels: connector name and state.
// Debezium snapshot/streaming JMX metrics are NOT covered; they need a JMX exporter.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const STATES = ["RUNNING", "PAUSED", "STOPPED", "FAILED", "UNASSIGNED"];

export function escapeLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

export function render({ connectUp, registryUp, connectors }) {
  const out = [
    "# HELP greenguard_connect_up 1 when the Kafka Connect REST API answered.",
    "# TYPE greenguard_connect_up gauge",
    `greenguard_connect_up ${connectUp}`,
    "# HELP greenguard_schema_registry_up 1 when the Schema Registry subjects endpoint answered.",
    "# TYPE greenguard_schema_registry_up gauge",
    `greenguard_schema_registry_up ${registryUp}`,
    "# HELP greenguard_connect_connector_state 1 for the connector's current state, 0 for others.",
    "# TYPE greenguard_connect_connector_state gauge",
  ];
  const tasks = [];
  const counts = [];
  for (const [name, entry] of Object.entries(connectors)) {
    const c = escapeLabel(name);
    const state = entry?.status?.connector?.state ?? "UNKNOWN";
    const states = STATES.includes(state) ? STATES : [...STATES, state];
    for (const s of states)
      out.push(
        `greenguard_connect_connector_state{connector="${c}",state="${escapeLabel(s)}"} ${s === state ? 1 : 0}`,
      );
    const list = entry?.status?.tasks ?? [];
    counts.push(
      `greenguard_connect_connector_tasks{connector="${c}"} ${list.length}`,
    );
    const seen = new Set(STATES);
    for (const t of list) seen.add(t.state);
    for (const s of seen)
      tasks.push(
        `greenguard_connect_task_state{connector="${c}",state="${escapeLabel(s)}"} ${list.filter((t) => t.state === s).length}`,
      );
  }
  out.push(
    "# HELP greenguard_connect_task_state Number of connector tasks in each state.",
    "# TYPE greenguard_connect_task_state gauge",
    ...tasks,
    "# HELP greenguard_connect_connector_tasks Number of tasks the connector reports.",
    "# TYPE greenguard_connect_connector_tasks gauge",
    ...counts,
  );
  return out.join("\n") + "\n";
}

async function getJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function collect({
  connectUrl,
  registryUrl,
  fetchImpl = fetch,
  timeoutMs = 3000,
}) {
  const [connect, registry] = await Promise.allSettled([
    getJson(fetchImpl, `${connectUrl}/connectors?expand=status`, timeoutMs),
    getJson(fetchImpl, `${registryUrl}/subjects`, timeoutMs),
  ]);
  return {
    connectUp: connect.status === "fulfilled" ? 1 : 0,
    registryUp: registry.status === "fulfilled" ? 1 : 0,
    connectors: connect.status === "fulfilled" ? connect.value : {},
  };
}

export function start(env = process.env) {
  const connectUrl = env.CONNECT_URL ?? "http://host.docker.internal:58083";
  const registryUrl =
    env.SCHEMA_REGISTRY_URL ?? "http://host.docker.internal:58081";
  const port = Number(env.PORT ?? 9309);
  const server = createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    const body = render(await collect({ connectUrl, registryUrl }));
    res
      .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
      .end(body);
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) start();
