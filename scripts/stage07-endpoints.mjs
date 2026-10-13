const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseEndpoint(value, scheme, label) {
  let endpoint;
  try {
    endpoint = new URL(value.includes("://") ? value : `${scheme}://${value}`);
  } catch {
    throw new Error(`${label} must be a valid loopback endpoint`);
  }
  if (
    endpoint.protocol !== `${scheme}:` ||
    !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase()) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  ) {
    throw new Error(`${label} must use a loopback host and explicit port`);
  }
  return endpoint;
}

export function stage07Endpoints(env = process.env) {
  const kafkaBrokers = (env.STAGE07_KAFKA_BROKERS || "127.0.0.1:59092")
    .split(",")
    .map((broker) => broker.trim());
  if (kafkaBrokers.length === 0 || kafkaBrokers.some((broker) => !broker)) {
    throw new Error("STAGE07_KAFKA_BROKERS must list loopback brokers");
  }
  for (const broker of kafkaBrokers)
    parseEndpoint(broker, "tcp", "STAGE07_KAFKA_BROKERS");

  const mqtt = parseEndpoint(
    env.STAGE07_MQTT_BROKER_URL || "tcp://127.0.0.1:51883",
    "tcp",
    "STAGE07_MQTT_BROKER_URL",
  );
  return { kafkaBrokers, mqttBrokerUrl: mqtt.href };
}
