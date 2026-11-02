package com.greenguard.stream;

import static com.greenguard.stream.TestData.*;
import static org.junit.jupiter.api.Assertions.*;

import com.greenguard.stream.Model.Rejection;
import java.util.Base64;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;

class TelemetryParserTest {
  private static final String KEY = tenant(1) + ":" + device(1);
  private static final String OK = json(tenant(1), device(1), uuid(5), T0, 20.5, 55.0);

  private static TelemetryParser.Result parse(UnaryOperator<String> edit) {
    return TelemetryParser.parse(KEY, edit.apply(OK));
  }

  private static void rejects(String reason, UnaryOperator<String> edit) {
    TelemetryParser.Result r = parse(edit);
    assertNull(r.event, "must reject");
    assertEquals(reason, r.reason, r.detail);
  }

  @Test
  void acceptsAValidEvent() {
    TelemetryParser.Result r = TelemetryParser.parse(KEY, OK);
    assertNotNull(r.event);
    assertEquals(tenant(1), r.event.tenantId);
    assertEquals(device(1), r.event.deviceId);
    assertEquals(T0, r.event.observedAtMs);
    assertEquals(20.5, r.event.temperatureC);
    assertEquals(55.0, r.event.humidityPct);
    assertNull(r.event.binId);
    assertEquals(KEY, r.event.key());
  }

  @Test
  void acceptsSingleMetricAndNullBinOrBin() {
    assertNull(TelemetryParser.parse(KEY, json(tenant(1), device(1), uuid(5), T0, 20.0, null)).event.humidityPct);
    assertNull(TelemetryParser.parse(KEY, json(tenant(1), device(1), uuid(5), T0, null, 40.0)).event.temperatureC);
    assertEquals(uuid(11), parse(s -> s.replace("\"bin_id\":null", "\"bin_id\":\"" + uuid(11) + "\"")).event.binId);
  }

  @Test
  void rejectsStructuralProblems() {
    rejects("bad_json", s -> "{not json");
    rejects("bad_json", s -> "");
    rejects("bad_envelope", s -> "[1,2]");
    rejects("bad_envelope", s -> s.replace("\"event_type\":\"telemetry.recorded\"", "\"event_type\":\"other\""));
    rejects("bad_envelope", s -> s.replace("\"schema_version\":1", "\"schema_version\":2"));
    rejects("bad_envelope", s -> s.replace("\"schema_version\":1", "\"schema_version\":\"1\""));
    rejects("bad_envelope", s -> s.replace("\"aggregate_type\":\"device_telemetry_stream\"", "\"aggregate_type\":\"x\""));
    rejects("bad_envelope", s -> s.replaceFirst("\\{", "{\"extra\":1,"));
    rejects("bad_envelope", s -> s.replace("\"causation_id\"", "\"causation_idx\""));
    rejects("bad_envelope", s -> s.replace("\"payload\":{", "\"payload\":{\"extra\":1,"));
    rejects("bad_envelope", s -> s.replaceFirst("\"payload\":\\{.*\\}\\}$", "\"payload\":5}"));
  }

  @Test
  void rejectsInvalidFields() {
    rejects("bad_field", s -> s.replace(tenant(1), tenant(1).toUpperCase().replace("-", "-") + "x"));
    rejects("bad_field", s -> s.replace("\"aggregate_version\":\"1\"", "\"aggregate_version\":\"0\""));
    rejects("bad_field", s -> s.replace("\"aggregate_version\":\"1\"", "\"aggregate_version\":\"99999999999999999999\""));
    rejects("bad_field", s -> s.replace("\"aggregate_version\":\"1\"", "\"aggregate_version\":\"9999999999999999999\""));
    rejects("bad_field", s -> s.replace("\"aggregate_version\":\"1\"", "\"aggregate_version\":1"));
    rejects("bad_field", s -> s.replace("\"binding_version\":\"1\"", "\"binding_version\":\"-1\""));
    rejects("bad_field", s -> s.replaceFirst("\"occurred_at\":\"[^\"]+\"", "\"occurred_at\":\"yesterday\""));
    rejects("bad_field", s -> s.replaceFirst("\"observed_at\":\"[^\"]+\"", "\"observed_at\":\"2026-13-45T25:61:61Z\""));
    rejects("bad_field", s -> s.replaceFirst("\"observed_at\":\"[^\"]+\"", "\"observed_at\":\"2026-01-01T00:00:00+01:00\""));
    rejects("bad_field", s -> s.replace("\"source_message_id\":\"m-", "\"source_message_id\":\"-m-"));
    rejects("bad_field", s -> s.replace(traceparent(), "00-00000000000000000000000000000000-b7ad6b7169203331-01"));
    rejects("bad_field", s -> s.replace(traceparent(), "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01"));
    rejects("bad_field", s -> s.replace(traceparent(), "garbage"));
    rejects("bad_field", s -> s.replace("\"temperature_c\":20.5", "\"temperature_c\":121"));
    rejects("bad_field", s -> s.replace("\"temperature_c\":20.5", "\"temperature_c\":-80.1"));
    rejects("bad_field", s -> s.replace("\"relative_humidity_percent\":55.0", "\"relative_humidity_percent\":100.5"));
    rejects("bad_field", s -> s.replace("\"temperature_c\":20.5", "\"temperature_c\":\"hot\""));
    rejects("bad_field", s -> s.replace("\"temperature_c\":20.5,\"relative_humidity_percent\":55.0", "\"co2\":1"));
    rejects("bad_field", s -> s.replace("\"temperature_c\":20.5,\"relative_humidity_percent\":55.0", ""));
  }

  @Test
  void enforcesTenantAndAggregateConsistency() {
    // aggregate_id must equal payload.device_id (architecture review H5)
    rejects("bad_field", s -> s.replace("\"aggregate_id\":\"" + device(1) + "\"", "\"aggregate_id\":\"" + device(2) + "\""));
    // the Kafka key must equal tenant:aggregate; another tenant's key can never be accepted
    assertEquals("key_mismatch", TelemetryParser.parse(tenant(2) + ":" + device(1), OK).reason);
    assertEquals("key_mismatch", TelemetryParser.parse(tenant(1) + ":" + device(2), OK).reason);
    assertEquals("key_mismatch", TelemetryParser.parse(null, OK).reason);
  }

  @Test
  void rejectsObservedAtThatCouldMoveTheWatermarkForOtherTenants() {
    long received = T0 + 1000;
    String base = json(tenant(1), device(1), uuid(5), T0, 20.5, 55.0);
    java.util.function.Function<Long, String> at = ms -> base.replaceFirst("\"observed_at\":\"[^\"]+\"", "\"observed_at\":\"" + iso(ms) + "\"");
    assertNotNull(TelemetryParser.parse(KEY, at.apply(received + TelemetryParser.MAX_FUTURE_SKEW_MS)).event, "exactly at the limit");
    assertEquals("bad_field", TelemetryParser.parse(KEY, at.apply(received + TelemetryParser.MAX_FUTURE_SKEW_MS + 1)).reason);
    assertEquals("bad_field", TelemetryParser.parse(KEY, at.apply(4_102_444_800_000L)).reason, "year 2100");
    assertEquals("bad_field", TelemetryParser.parse(KEY, at.apply(TelemetryParser.MIN_OBSERVED_MS - 1)).reason);
    assertEquals("bad_field", TelemetryParser.parse(KEY, base.replaceFirst("\"observed_at\":\"[^\"]+\"", "\"observed_at\":\"1960-01-01T00:00:00Z\"")).reason);
  }

  @Test
  void rejectionIsBoundedAndTenantHintIsValidatedOnly() {
    byte[] big = new byte[TelemetryParser.MAX_RAW_BYTES + 10];
    java.util.Arrays.fill(big, (byte) 'x');
    Rejection r = TelemetryParser.rejection("bad_json", "x".repeat(1000), "t", 3, 9, big);
    assertTrue(r.truncated);
    assertEquals(256, r.detail.length());
    assertEquals(TelemetryParser.MAX_RAW_BYTES, Base64.getDecoder().decode(r.rawBase64).length);
    assertEquals("unknown", r.tenantHint);

    Rejection ok = TelemetryParser.rejection("bad_field", "d", "t", 0, 1, OK.getBytes());
    assertEquals(tenant(1), ok.tenantHint);
    assertFalse(ok.truncated);
    String hostile = "{\"tenant_id\":\"not-a-uuid\"}";
    assertEquals("unknown", TelemetryParser.rejection("bad_field", "d", "t", 0, 1, hostile.getBytes()).tenantHint);
    assertEquals("unknown", TelemetryParser.rejection("bad_json", "d", "t", 0, 1, null).tenantHint);
    assertEquals("unknown", TelemetryParser.rejection("bad_json", "d", "t", 0, 1, "{{".getBytes()).tenantHint);
  }
}
