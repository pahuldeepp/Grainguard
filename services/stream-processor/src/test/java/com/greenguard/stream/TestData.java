package com.greenguard.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.StreamInput;
import com.greenguard.stream.Model.TelemetryEvent;
import com.networknt.schema.InputFormat;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class TestData {
  static final long T0 = 1_767_225_600_000L; // 2026-01-01T00:00:00Z, divisible by 5 minutes
  static final long MIN = 60_000L;
  static final ObjectMapper JSON = new ObjectMapper();

  private TestData() {}

  static String uuid(long n) {
    return String.format("00000000-0000-4000-8000-%012d", n);
  }

  static String tenant(int n) {
    return uuid(n);
  }

  static String device(int n) {
    return uuid(100 + n);
  }

  static String traceparent() {
    return "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  }

  static String iso(long ms) {
    return DerivedEvents.iso(ms);
  }

  /** A canonical telemetry.recorded v1 event, as the CDC transformer would publish it. */
  static String json(String tenant, String device, String eventId, long observedMs, Double temp, Double hum) {
    String m = (temp == null ? "" : "\"temperature_c\":" + temp)
        + (temp != null && hum != null ? "," : "") + (hum == null ? "" : "\"relative_humidity_percent\":" + hum);
    return "{\"event_id\":\"" + eventId + "\",\"event_type\":\"telemetry.recorded\",\"schema_version\":1,"
        + "\"occurred_at\":\"" + iso(observedMs) + "\",\"tenant_id\":\"" + tenant
        + "\",\"aggregate_type\":\"device_telemetry_stream\",\"aggregate_id\":\"" + device
        + "\",\"aggregate_version\":\"1\",\"correlation_id\":\"" + uuid(7) + "\",\"causation_id\":\"" + uuid(8)
        + "\",\"traceparent\":\"" + traceparent() + "\",\"payload\":{\"reading_id\":\"" + uuid(9)
        + "\",\"device_id\":\"" + device + "\",\"site_id\":\"" + uuid(10) + "\",\"bin_id\":null,"
        + "\"binding_version\":\"1\",\"source_message_id\":\"m-" + eventId + "\",\"observed_at\":\""
        + iso(observedMs) + "\",\"received_at\":\"" + iso(observedMs + 1000) + "\",\"measurements\":{" + m + "}}}";
  }

  static TelemetryEvent event(int tenant, int device, long id, long observedMs, Double temp, Double hum) {
    String key = tenant(tenant) + ":" + device(device);
    TelemetryParser.Result r = TelemetryParser.parse(key, json(tenant(tenant), device(device), uuid(id), observedMs,
        temp, hum));
    assertTrue(r.event != null, "test event must parse: " + r.reason + " " + r.detail);
    r.event.sourceTopic = "greenguard.telemetry.recorded.v1";
    r.event.sourcePartition = 0;
    r.event.sourceOffset = id;
    return r.event;
  }

  static StreamInput input(TelemetryEvent e) {
    StreamInput in = new StreamInput();
    in.event = e;
    return in;
  }

  static StreamInput raw(String key, String value, long offset) {
    TelemetryParser.Result r = TelemetryParser.parse(key, value);
    StreamInput in = new StreamInput();
    if (r.event != null) {
      in.event = r.event;
      in.event.sourceTopic = "greenguard.telemetry.recorded.v1";
      in.event.sourceOffset = offset;
    } else {
      in.rejection = TelemetryParser.rejection(r.reason, r.detail, "greenguard.telemetry.recorded.v1", 0, offset,
          value == null ? null : value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    return in;
  }

  static Config config(Map<String, String> overrides) {
    Map<String, String> env = new HashMap<>();
    env.put("KAFKA_BROKERS", "localhost:9092");
    env.put("WINDOW_SIZE", "10m");
    env.put("WINDOW_SLIDE", "5m");
    env.put("ALLOWED_LATENESS", "5m");
    env.put("MAX_OUT_OF_ORDER", "1m");
    env.put("PARALLELISM", "1");
    env.put("ANOMALY_MIN_SAMPLES", "5");
    env.put("ANOMALY_ALPHA", "0.2");
    env.put("ANOMALY_COOLDOWN", "1m");
    env.putAll(overrides);
    return Config.from(env::get);
  }

  private static final Map<String, JsonSchema> SCHEMAS = new HashMap<>();

  static JsonSchema schema(String file) throws IOException {
    synchronized (SCHEMAS) {
      JsonSchema s = SCHEMAS.get(file);
      if (s == null) {
        Path path = Path.of("../../contracts/stream/" + file).toAbsolutePath().normalize();
        SchemaValidatorsConfig cfg = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();
        s = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012)
            .getSchema(Files.readString(path), InputFormat.JSON, cfg);
        SCHEMAS.put(file, s);
      }
      return s;
    }
  }

  /** Validates the record against its checked-in contract and the tenant-key invariant. */
  static JsonNode assertValid(OutRecord r) throws IOException {
    String file = switch (r.eventType) {
      case DerivedEvents.AGGREGATE_TYPE -> "telemetry-aggregate.v1.schema.json";
      case DerivedEvents.ANOMALY_TYPE -> "telemetry-anomaly.v1.schema.json";
      default -> "stream-dlq.v1.schema.json";
    };
    Set<com.networknt.schema.ValidationMessage> errors = schema(file).validate(r.value, InputFormat.JSON);
    assertTrue(errors.isEmpty(), r.eventType + " violates its schema: " + errors + " in " + r.value);
    JsonNode body = JSON.readTree(r.value);
    if (!r.eventType.equals(DerivedEvents.DLQ_TYPE)) {
      assertTrue(r.key.equals(body.get("tenant_id").asText() + ":" + body.get("aggregate_id").asText()),
          "key must be tenant:aggregate");
      assertTrue(r.tenantId.equals(body.get("tenant_id").asText()), "header tenant must match body");
    }
    return body;
  }

  static List<JsonNode> ofType(List<OutRecord> all, String type) throws IOException {
    java.util.ArrayList<JsonNode> out = new java.util.ArrayList<>();
    for (OutRecord r : all) {
      if (r.eventType.equals(type)) {
        out.add(assertValid(r));
      }
    }
    return out;
  }
}
