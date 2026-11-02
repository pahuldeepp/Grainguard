package com.greenguard.stream;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.greenguard.stream.Model.Rejection;
import com.greenguard.stream.Model.TelemetryEvent;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Strict parser for the canonical telemetry.recorded v1 envelope. It mirrors the repository JSON Schema
 * and the cross-field rules the other validators apply (aggregate_id equals payload.device_id, key equals
 * tenant:aggregate, non-zero trace IDs). Nothing is guessed or defaulted.
 */
public final class TelemetryParser {
  public static final int MAX_RAW_BYTES = 64 * 1024;
  public static final String UNKNOWN_TENANT = "unknown";

  /** Same future limit as ingest (ADR-0006); a reading further ahead would move a partition's watermark for everyone. */
  static final long MAX_FUTURE_SKEW_MS = 5 * 60_000L;
  static final long MIN_OBSERVED_MS = 1_577_836_800_000L; // 2020-01-01T00:00:00Z
  static final String BAD_JSON = "bad_json";
  static final String BAD_ENVELOPE = "bad_envelope";
  static final String BAD_FIELD = "bad_field";
  static final String KEY_MISMATCH = "key_mismatch";

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
  private static final Pattern TIMESTAMP =
      Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z");
  private static final Pattern TRACEPARENT = Pattern.compile("00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)");
  private static final Pattern BIGINT = Pattern.compile("[1-9][0-9]{0,18}");
  private static final Pattern SOURCE_MESSAGE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
  private static final Set<String> ENVELOPE_KEYS = new HashSet<>(Arrays.asList("event_id", "event_type",
      "schema_version", "occurred_at", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version",
      "correlation_id", "causation_id", "traceparent", "payload"));
  private static final Set<String> PAYLOAD_KEYS = new HashSet<>(Arrays.asList("reading_id", "device_id", "site_id",
      "bin_id", "binding_version", "source_message_id", "observed_at", "received_at", "measurements"));

  private TelemetryParser() {}

  /** Either an event or a stable rejection reason. */
  public static final class Result {
    public final TelemetryEvent event;
    public final String reason;
    public final String detail;

    private Result(TelemetryEvent event, String reason, String detail) {
      this.event = event;
      this.reason = reason;
      this.detail = detail;
    }
  }

  private static final class Reject extends Exception {
    private static final long serialVersionUID = 1L;
    final String reason;

    Reject(String reason, String detail) {
      super(detail, null, false, false);
      this.reason = reason;
    }
  }

  public static Result parse(String key, String value) {
    try {
      return new Result(parseOrThrow(key, value), null, null);
    } catch (Reject r) {
      return new Result(null, r.reason, bounded(r.getMessage()));
    }
  }

  private static TelemetryEvent parseOrThrow(String key, String value) throws Reject {
    if (value == null || value.isEmpty()) {
      throw new Reject(BAD_JSON, "empty value");
    }
    JsonNode root;
    try {
      root = MAPPER.readTree(value);
    } catch (JsonProcessingException e) {
      throw new Reject(BAD_JSON, "not valid JSON");
    }
    if (root == null || !root.isObject()) {
      throw new Reject(BAD_ENVELOPE, "envelope must be a JSON object");
    }
    requireKeys(root, ENVELOPE_KEYS, BAD_ENVELOPE, "envelope");
    if (!"telemetry.recorded".equals(text(root, "event_type", BAD_ENVELOPE))
        || !root.get("schema_version").isInt() || root.get("schema_version").intValue() != 1
        || !"device_telemetry_stream".equals(text(root, "aggregate_type", BAD_ENVELOPE))) {
      throw new Reject(BAD_ENVELOPE, "unsupported event_type, schema_version or aggregate_type");
    }
    JsonNode payload = root.get("payload");
    if (!payload.isObject()) {
      throw new Reject(BAD_ENVELOPE, "payload must be an object");
    }
    requireKeys(payload, PAYLOAD_KEYS, BAD_ENVELOPE, "payload");

    TelemetryEvent e = new TelemetryEvent();
    e.eventId = uuid(root, "event_id");
    e.tenantId = uuid(root, "tenant_id");
    String aggregate = uuid(root, "aggregate_id");
    e.correlationId = uuid(root, "correlation_id");
    uuid(root, "causation_id");
    e.aggregateVersion = bigint(root, "aggregate_version");
    timestamp(root, "occurred_at");
    e.traceparent = traceparent(root);
    e.readingId = uuid(payload, "reading_id");
    e.deviceId = uuid(payload, "device_id");
    e.siteId = uuid(payload, "site_id");
    JsonNode bin = payload.get("bin_id");
    e.binId = bin.isNull() ? null : uuid(payload, "bin_id");
    bigint(payload, "binding_version");
    if (!SOURCE_MESSAGE.matcher(text(payload, "source_message_id", BAD_FIELD)).matches()) {
      throw new Reject(BAD_FIELD, "source_message_id has an invalid format");
    }
    e.observedAtMs = timestamp(payload, "observed_at");
    long receivedMs = timestamp(payload, "received_at");
    // One far-future or pre-epoch observed_at would stall or skew the watermark for other tenants on its partition.
    if (e.observedAtMs < MIN_OBSERVED_MS || e.observedAtMs - MAX_FUTURE_SKEW_MS > receivedMs) {
      throw new Reject(BAD_FIELD, "observed_at is outside the accepted range");
    }
    measurements(payload.get("measurements"), e);
    if (!aggregate.equals(e.deviceId)) {
      throw new Reject(BAD_FIELD, "aggregate_id must equal payload.device_id");
    }
    if (key == null || !key.equals(e.tenantId + ":" + aggregate)) {
      throw new Reject(KEY_MISMATCH, "Kafka key must equal tenant_id:aggregate_id");
    }
    return e;
  }

  private static void measurements(JsonNode m, TelemetryEvent e) throws Reject {
    if (m == null || !m.isObject() || m.size() == 0) {
      throw new Reject(BAD_FIELD, "measurements must contain at least one metric");
    }
    Iterator<String> names = m.fieldNames();
    while (names.hasNext()) {
      String n = names.next();
      if (!n.equals("temperature_c") && !n.equals("relative_humidity_percent")) {
        throw new Reject(BAD_FIELD, "unknown measurement");
      }
    }
    if (m.has("temperature_c")) {
      e.temperatureC = number(m.get("temperature_c"), -80, 120, "temperature_c");
    }
    if (m.has("relative_humidity_percent")) {
      e.humidityPct = number(m.get("relative_humidity_percent"), 0, 100, "relative_humidity_percent");
    }
  }

  private static double number(JsonNode n, double min, double max, String name) throws Reject {
    if (!n.isNumber()) {
      throw new Reject(BAD_FIELD, name + " must be a number");
    }
    double v = n.doubleValue();
    if (Double.isNaN(v) || Double.isInfinite(v) || v < min || v > max) {
      throw new Reject(BAD_FIELD, name + " is outside the input limits");
    }
    return v;
  }

  private static void requireKeys(JsonNode node, Set<String> allowed, String reason, String what) throws Reject {
    Iterator<String> names = node.fieldNames();
    int seen = 0;
    while (names.hasNext()) {
      if (!allowed.contains(names.next())) {
        throw new Reject(reason, what + " has an unknown field");
      }
      seen++;
    }
    if (seen != allowed.size()) {
      throw new Reject(reason, what + " is missing a required field");
    }
  }

  private static String text(JsonNode node, String name, String reason) throws Reject {
    JsonNode v = node.get(name);
    if (v == null || !v.isTextual()) {
      throw new Reject(reason, name + " must be a string");
    }
    return v.textValue();
  }

  private static String uuid(JsonNode node, String name) throws Reject {
    String v = text(node, name, BAD_FIELD);
    if (!UUID.matcher(v).matches()) {
      throw new Reject(BAD_FIELD, name + " must be a lowercase UUID");
    }
    return v;
  }

  private static long bigint(JsonNode node, String name) throws Reject {
    String v = text(node, name, BAD_FIELD);
    if (!BIGINT.matcher(v).matches()) {
      throw new Reject(BAD_FIELD, name + " must be a positive bigint string");
    }
    try {
      return Long.parseLong(v);
    } catch (NumberFormatException e) {
      throw new Reject(BAD_FIELD, name + " exceeds bigint");
    }
  }

  private static long timestamp(JsonNode node, String name) throws Reject {
    String v = text(node, name, BAD_FIELD);
    if (!TIMESTAMP.matcher(v).matches()) {
      throw new Reject(BAD_FIELD, name + " must be a UTC timestamp");
    }
    try {
      return Instant.parse(v).toEpochMilli();
    } catch (RuntimeException e) {
      throw new Reject(BAD_FIELD, name + " is not a valid date-time");
    }
  }

  private static String traceparent(JsonNode root) throws Reject {
    String v = text(root, "traceparent", BAD_FIELD);
    java.util.regex.Matcher m = TRACEPARENT.matcher(v);
    if (!m.matches() || m.group(1).chars().allMatch(c -> c == '0') || m.group(2).chars().allMatch(c -> c == '0')) {
      throw new Reject(BAD_FIELD, "traceparent must be a non-zero W3C version-00 context");
    }
    return v;
  }

  static String bounded(String detail) {
    String d = detail == null ? "" : detail;
    return d.length() > 256 ? d.substring(0, 256) : d;
  }

  /** Best-effort tenant for the DLQ header; only a lowercase UUID is ever returned. */
  static String tenantHint(String raw) {
    if (raw == null) {
      return UNKNOWN_TENANT;
    }
    try {
      JsonNode t = MAPPER.readTree(raw).path("tenant_id");
      return t.isTextual() && UUID.matcher(t.textValue()).matches() ? t.textValue() : UNKNOWN_TENANT;
    } catch (Exception e) {
      return UNKNOWN_TENANT;
    }
  }

  public static Rejection rejection(String reason, String detail, String topic, int partition, long offset,
      byte[] rawBytes) {
    Rejection r = new Rejection();
    byte[] raw = rawBytes == null ? new byte[0] : rawBytes;
    r.reason = reason;
    r.detail = bounded(detail);
    r.sourceTopic = topic;
    r.sourcePartition = partition;
    r.sourceOffset = offset;
    r.truncated = raw.length > MAX_RAW_BYTES;
    r.rawBase64 = Base64.getEncoder().encodeToString(r.truncated ? Arrays.copyOf(raw, MAX_RAW_BYTES) : raw);
    r.tenantHint = tenantHint(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
    return r;
  }
}
