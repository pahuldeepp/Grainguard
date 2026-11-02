package com.greenguard.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.Rejection;
import com.greenguard.stream.Model.TelemetryEvent;
import com.greenguard.stream.Model.WindowAcc;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.UUID;

/** Builds derived events. IDs are deterministic UUIDv5, so replay and restart reproduce identical events. */
public final class DerivedEvents {
  public static final String AGGREGATE_TYPE = "telemetry.aggregate";
  public static final String ANOMALY_TYPE = "telemetry.anomaly";
  public static final String DLQ_TYPE = "stream.dlq";
  static final UUID NAMESPACE = UUID.fromString("8c0a3f7e-5a9b-4f43-9d1e-6b2f0c7d4a11");
  private static final JsonMapper MAPPER =
      JsonMapper.builder().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();

  private DerivedEvents() {}

  /** RFC 4122 version 5 (SHA-1) name-based UUID. */
  static UUID uuidV5(String name) {
    return uuidV5(NAMESPACE, name);
  }

  static UUID uuidV5(UUID namespace, String name) {
    try {
      MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
      sha1.update(toBytes(namespace));
      byte[] hash = sha1.digest(name.getBytes(StandardCharsets.UTF_8));
      hash[6] = (byte) ((hash[6] & 0x0f) | 0x50);
      hash[8] = (byte) ((hash[8] & 0x3f) | 0x80);
      long msb = 0;
      long lsb = 0;
      for (int i = 0; i < 8; i++) {
        msb = (msb << 8) | (hash[i] & 0xff);
      }
      for (int i = 8; i < 16; i++) {
        lsb = (lsb << 8) | (hash[i] & 0xff);
      }
      return new UUID(msb, lsb);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static byte[] toBytes(UUID u) {
    byte[] out = new byte[16];
    for (int i = 0; i < 8; i++) {
      out[i] = (byte) (u.getMostSignificantBits() >>> (8 * (7 - i)));
      out[8 + i] = (byte) (u.getLeastSignificantBits() >>> (8 * (7 - i)));
    }
    return out;
  }

  static String iso(long ms) {
    return Instant.ofEpochMilli(ms).toString();
  }

  private static double round(double v) {
    return Math.round(v * 1_000_000d) / 1_000_000d;
  }

  private static ObjectNode envelope(String id, String type, long occurredMs, String tenant, String device,
      String correlation, String causation, String traceparent) {
    ObjectNode n = MAPPER.createObjectNode();
    n.put("event_id", id);
    n.put("event_type", type);
    n.put("schema_version", 1);
    n.put("occurred_at", iso(occurredMs));
    n.put("tenant_id", tenant);
    n.put("aggregate_type", "device_telemetry_stream");
    n.put("aggregate_id", device);
    n.put("correlation_id", correlation);
    n.put("causation_id", causation);
    n.put("traceparent", traceparent);
    return n;
  }

  private static ObjectNode stats(long n, double min, double max, double sum) {
    ObjectNode s = MAPPER.createObjectNode();
    s.put("count", n);
    s.put("min", round(min));
    s.put("max", round(max));
    s.put("mean", round(sum / n));
    return s;
  }

  private static OutRecord record(String topic, String type, ObjectNode body, String tenant, String device,
      String traceparent) {
    OutRecord r = new OutRecord();
    r.topic = topic;
    r.key = tenant + ":" + device;
    r.eventType = type;
    r.tenantId = tenant;
    r.traceparent = traceparent;
    r.value = write(body);
    return r;
  }

  static String write(JsonNode node) {
    try {
      return MAPPER.writeValueAsString(node);
    } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  public static OutRecord aggregate(String topic, WindowAcc a, long startMs, long endMs, long sizeMs, long slideMs,
      int revision) {
    String id = uuidV5("telemetry.aggregate|" + a.tenantId + "|" + a.deviceId + "|" + startMs + "|" + endMs + "|"
        + sizeMs).toString();
    ObjectNode body = envelope(id, AGGREGATE_TYPE, endMs, a.tenantId, a.deviceId, a.lastCorrelation, a.lastEventId,
        a.lastTraceparent);
    ObjectNode p = body.putObject("payload");
    p.put("device_id", a.deviceId);
    p.put("site_id", a.siteId);
    if (a.binId == null) {
      p.putNull("bin_id");
    } else {
      p.put("bin_id", a.binId);
    }
    p.put("window_start", iso(startMs));
    p.put("window_end", iso(endMs));
    p.put("window_size_seconds", sizeMs / 1000);
    p.put("slide_seconds", slideMs / 1000);
    p.put("revision", revision);
    p.put("reading_count", a.count);
    p.put("last_observed_at", iso(a.lastMs));
    if (a.tempN > 0) {
      p.set("temperature_c", stats(a.tempN, a.tempMin, a.tempMax, a.tempSum));
    } else {
      p.putNull("temperature_c");
    }
    if (a.humN > 0) {
      p.set("relative_humidity_percent", stats(a.humN, a.humMin, a.humMax, a.humSum));
    } else {
      p.putNull("relative_humidity_percent");
    }
    return record(topic, AGGREGATE_TYPE, body, a.tenantId, a.deviceId, a.lastTraceparent);
  }

  public static OutRecord anomaly(String topic, TelemetryEvent e, String metric, String detector, double value,
      double mean, double stddev, double score) {
    String id = uuidV5("telemetry.anomaly|" + e.tenantId + "|" + e.deviceId + "|" + metric + "|" + detector + "|"
        + e.eventId).toString();
    ObjectNode body = envelope(id, ANOMALY_TYPE, e.observedAtMs, e.tenantId, e.deviceId, e.correlationId, e.eventId,
        e.traceparent);
    ObjectNode p = body.putObject("payload");
    p.put("device_id", e.deviceId);
    p.put("reading_id", e.readingId);
    p.put("site_id", e.siteId);
    if (e.binId == null) {
      p.putNull("bin_id");
    } else {
      p.put("bin_id", e.binId);
    }
    p.put("metric", metric);
    p.put("detector", detector);
    p.put("observed_at", iso(e.observedAtMs));
    p.put("value", round(value));
    p.put("baseline_mean", round(mean));
    p.put("baseline_stddev", round(stddev));
    p.put("score", round(score));
    p.put("advisory", true);
    return record(topic, ANOMALY_TYPE, body, e.tenantId, e.deviceId, e.traceparent);
  }

  public static OutRecord dlq(String topic, Rejection r) {
    ObjectNode body = MAPPER.createObjectNode();
    body.put("reason", r.reason);
    body.put("source_topic", r.sourceTopic);
    body.put("source_partition", r.sourcePartition);
    body.put("source_offset", r.sourceOffset);
    body.put("detail", r.detail);
    body.put("raw_base64", r.rawBase64);
    body.put("truncated", r.truncated);
    OutRecord out = new OutRecord();
    out.topic = topic;
    out.key = r.sourceTopic + ":" + r.sourcePartition + ":" + r.sourceOffset;
    out.eventType = DLQ_TYPE;
    out.tenantId = r.tenantHint == null ? TelemetryParser.UNKNOWN_TENANT : r.tenantHint;
    out.reason = r.reason;
    out.value = write(body);
    return out;
  }

  /** A reading beyond allowed lateness: already in history, but excluded from the streaming aggregate. */
  public static OutRecord late(String topic, TelemetryEvent e) {
    Rejection r = new Rejection();
    r.reason = "late";
    r.detail = "event_id=" + e.eventId + " observed_at=" + iso(e.observedAtMs);
    r.sourceTopic = e.sourceTopic;
    r.sourcePartition = e.sourcePartition;
    r.sourceOffset = e.sourceOffset;
    r.rawBase64 = "";
    r.truncated = false;
    r.tenantHint = e.tenantId;
    return dlq(topic, r);
  }
}
