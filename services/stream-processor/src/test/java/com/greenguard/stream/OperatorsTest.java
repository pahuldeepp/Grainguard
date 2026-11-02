package com.greenguard.stream;

import static com.greenguard.stream.TestData.*;
import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.greenguard.stream.Config.DetectorSettings;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.TelemetryEvent;
import java.util.ArrayList;
import java.util.List;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.api.watermark.Watermark;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.junit.jupiter.api.Test;

/** Deterministic operator tests: watermarks and checkpoints are driven by hand. */
class OperatorsTest {
  private static final DetectorSettings S =
      new DetectorSettings(0.2, 4.0, 5, 60_000, 5.0, 10.0, 600_000, 3);

  private static KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> detector() throws Exception {
    KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> h =
        new KeyedOneInputStreamOperatorTestHarness<>(
            new KeyedProcessOperator<>(new Operators.AnomalyDetector(S, "an")), new Operators.DeviceKey(),
            org.apache.flink.api.common.typeinfo.Types.STRING);
    h.open();
    return h;
  }

  private static KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, TelemetryEvent> dedupe()
      throws Exception {
    KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, TelemetryEvent> h =
        new KeyedOneInputStreamOperatorTestHarness<>(new KeyedProcessOperator<>(new Operators.Dedupe(3_600_000)),
            new Operators.DeviceKey(), org.apache.flink.api.common.typeinfo.Types.STRING);
    h.open();
    return h;
  }

  private static void feed(KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> h, int tenant,
      int device, long id, long minute, Double temp, Double hum) throws Exception {
    long ts = T0 + minute * MIN;
    h.processElement(new StreamRecord<>(event(tenant, device, id, ts, temp, hum), ts));
  }

  private static void feedSteady(KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> h,
      int count) throws Exception {
    for (int i = 0; i < count; i++) {
      feed(h, 1, 1, 100 + i, i, 20.0 + (i % 2) * 0.05, null);
    }
    h.processWatermark(new Watermark(T0 + count * MIN));
  }

  private static List<JsonNode> anomalies(KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> h)
      throws Exception {
    List<JsonNode> out = new ArrayList<>();
    for (OutRecord r : h.extractOutputValues()) {
      out.add(assertValid(r));
    }
    return out;
  }

  @Test
  void steadyReadingsProduceNoAnomaly() throws Exception {
    try (var h = detector()) {
      feedSteady(h, 20);
      assertTrue(anomalies(h).isEmpty());
    }
  }

  @Test
  void sustainedOffsetIsReportedAsZscoreOnly() throws Exception {
    try (var h = detector()) {
      feedSteady(h, 12);
      feed(h, 1, 1, 500, 13, 20.8, null); // +0.8C in 1 min: slow, but 8 sigma over the 0.1C floor
      h.processWatermark(new Watermark(T0 + 14 * MIN));
      List<JsonNode> a = anomalies(h);
      assertEquals(1, a.size());
      assertEquals("zscore", a.get(0).get("payload").get("detector").asText());
      assertEquals("temperature_c", a.get(0).get("payload").get("metric").asText());
      assertEquals(uuid(500), a.get(0).get("causation_id").asText());
    }
  }

  @Test
  void steepStepIsReportedAsRapidChange() throws Exception {
    try (var h = detector()) {
      feedSteady(h, 12);
      feed(h, 1, 1, 501, 13, 32.0, null); // +12C over the 2 minute gap since the last reading: 6C/min
      h.processWatermark(new Watermark(T0 + 14 * MIN));
      List<JsonNode> a = anomalies(h);
      assertEquals(1, a.size());
      assertEquals("rapid_change", a.get(0).get("payload").get("detector").asText());
      assertTrue(a.get(0).get("payload").get("score").asDouble() >= 5.0);
    }
  }

  @Test
  void humidityIsEvaluatedIndependently() throws Exception {
    try (var h = detector()) {
      for (int i = 0; i < 12; i++) {
        feed(h, 1, 1, 200 + i, i, 20.0, 50.0 + (i % 2) * 0.1);
      }
      feed(h, 1, 1, 300, 13, 20.0, 75.0);
      h.processWatermark(new Watermark(T0 + 14 * MIN));
      List<JsonNode> a = anomalies(h);
      assertEquals(1, a.size());
      assertEquals("relative_humidity_percent", a.get(0).get("payload").get("metric").asText());
    }
  }

  @Test
  void outOfOrderArrivalIsProcessedInEventTimeOrder() throws Exception {
    // t1=20, t2=20, t3=27 delivered as t3, t1, t2. Arrival-order processing would compare t3 with nothing
    // or with the wrong neighbour; event-time order sees a +7C step between t2 and t3.
    try (var h = detector()) {
      feed(h, 1, 1, 601, 3, 27.0, null);
      feed(h, 1, 1, 602, 1, 20.0, null);
      feed(h, 1, 1, 603, 2, 20.0, null);
      assertTrue(h.extractOutputValues().isEmpty(), "nothing is released before the watermark");
      h.processWatermark(new Watermark(T0 + 5 * MIN));
      List<JsonNode> a = anomalies(h);
      assertEquals(1, a.size());
      assertEquals(uuid(601), a.get(0).get("causation_id").asText());
      assertEquals(20.0, a.get(0).get("payload").get("baseline_mean").asDouble());
    }
  }

  @Test
  void eventBehindTheWatermarkIsSkippedNotReordered() throws Exception {
    try (var h = detector()) {
      feedSteady(h, 12);
      h.processWatermark(new Watermark(T0 + 30 * MIN));
      feed(h, 1, 1, 700, 5, 90.0, null); // would be a huge anomaly, but it is behind the watermark
      h.processWatermark(new Watermark(T0 + 40 * MIN));
      assertTrue(anomalies(h).isEmpty());
    }
  }

  @Test
  void cooldownSuppressesRepeatsAndSustainedShiftIsRelearned() throws Exception {
    try (var h = detector()) {
      feedSteady(h, 12);
      feed(h, 1, 1, 800, 13, 27.0, null);
      feed(h, 1, 1, 801, 13, 27.3, null); // same minute: inside the 1 minute cooldown (event time)
      h.processWatermark(new Watermark(T0 + 14 * MIN));
      assertEquals(1, anomalies(h).size());
      h.getOutput().clear();
      for (int i = 0; i < 6; i++) { // the new level persists: relearned after 3 consecutive outliers
        feed(h, 1, 1, 810 + i, 20 + i, 27.0 + (i % 2) * 0.05, null);
      }
      h.processWatermark(new Watermark(T0 + 40 * MIN));
      List<JsonNode> later = anomalies(h);
      assertTrue(later.size() <= 3, "outliers stop once the baseline is relearned: " + later.size());
      h.getOutput().clear();
      feed(h, 1, 1, 830, 41, 27.0, null);
      h.processWatermark(new Watermark(T0 + 50 * MIN));
      assertTrue(anomalies(h).isEmpty(), "27C is the new normal");
    }
  }

  @Test
  void detectorStateIsPerTenantAndDevice() throws Exception {
    try (var h = detector()) {
      for (int i = 0; i < 12; i++) {
        feed(h, 1, 1, 900 + i, i, 20.0 + (i % 2) * 0.05, null);
        feed(h, 2, 1, 950 + i, i, 60.0 + (i % 2) * 0.05, null); // same device UUID, another tenant, other baseline
      }
      feed(h, 2, 1, 990, 13, 60.8, null); // ~8 sigma over the 0.1C floor for tenant 2 only
      h.processWatermark(new Watermark(T0 + 14 * MIN));
      List<JsonNode> a = anomalies(h);
      assertEquals(1, a.size());
      assertEquals(tenant(2), a.get(0).get("tenant_id").asText());
    }
  }

  @Test
  void detectorRestoresFromCheckpointWithBufferedEvents() throws Exception {
    OperatorSubtaskState snapshot;
    List<String> expected;
    try (var reference = detector()) {
      feedSteady(reference, 12);
      feed(reference, 1, 1, 1000, 13, 27.0, null);
      reference.processWatermark(new Watermark(T0 + 14 * MIN));
      expected = ids(reference);
    }
    try (var first = detector()) {
      feedSteady(first, 12);
      feed(first, 1, 1, 1000, 13, 27.0, null); // buffered, not yet released
      snapshot = first.snapshot(1L, T0);
    }
    try (var restored = detector()) {
      restored.close();
    }
    var restored = new KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord>(
        new KeyedProcessOperator<>(new Operators.AnomalyDetector(S, "an")), new Operators.DeviceKey(),
        org.apache.flink.api.common.typeinfo.Types.STRING);
    restored.setup();
    restored.initializeState(snapshot);
    restored.open();
    restored.processWatermark(new Watermark(T0 + 14 * MIN));
    assertEquals(expected, ids(restored), "a restored job emits exactly what an uninterrupted job emits");
    restored.close();
  }

  private static List<String> ids(KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, OutRecord> h)
      throws Exception {
    List<String> out = new ArrayList<>();
    for (JsonNode n : anomalies(h)) {
      out.add(n.get("event_id").asText());
    }
    return out;
  }

  @Test
  void dedupeDropsRepeatedEventIdsPerDevice() throws Exception {
    try (var h = dedupe()) {
      TelemetryEvent e = event(1, 1, 1, T0, 20.0, null);
      h.processElement(new StreamRecord<>(e, T0));
      h.processElement(new StreamRecord<>(e, T0));
      h.processElement(new StreamRecord<>(event(1, 1, 2, T0 + MIN, 20.0, null), T0 + MIN));
      assertEquals(2, h.extractOutputValues().size());
      // identical event_id under another tenant/device key is a different state entry, never suppressed
      h.processElement(new StreamRecord<>(event(2, 1, 1, T0, 20.0, null), T0));
      assertEquals(3, h.extractOutputValues().size());
    }
  }

  @Test
  void dedupeSurvivesCheckpointRestore() throws Exception {
    OperatorSubtaskState snapshot;
    try (var h = dedupe()) {
      h.processElement(new StreamRecord<>(event(1, 1, 1, T0, 20.0, null), T0));
      snapshot = h.snapshot(1L, T0);
    }
    var restored = new KeyedOneInputStreamOperatorTestHarness<String, TelemetryEvent, TelemetryEvent>(
        new KeyedProcessOperator<>(new Operators.Dedupe(3_600_000)), new Operators.DeviceKey(),
        org.apache.flink.api.common.typeinfo.Types.STRING);
    restored.setup();
    restored.initializeState(snapshot);
    restored.open();
    restored.processElement(new StreamRecord<>(event(1, 1, 1, T0, 20.0, null), T0)); // replay after recovery
    restored.processElement(new StreamRecord<>(event(1, 1, 2, T0 + MIN, 20.0, null), T0 + MIN));
    assertEquals(1, restored.extractOutputValues().size(), "replayed event dropped, new event passes");
    restored.close();
  }
}
