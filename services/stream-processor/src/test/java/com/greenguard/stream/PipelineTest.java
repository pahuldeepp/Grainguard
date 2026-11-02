package com.greenguard.stream;

import static com.greenguard.stream.TestData.*;
import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.StreamInput;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.apache.flink.api.common.eventtime.Watermark;
import org.apache.flink.api.common.eventtime.WatermarkGenerator;
import org.apache.flink.api.common.eventtime.WatermarkOutput;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.util.CloseableIterator;
import org.junit.jupiter.api.Test;

/** Runs the real pipeline on a Flink mini cluster with a deterministic, punctuated watermark. */
class PipelineTest {
  private static final Config CFG = config(Map.of());

  /** Same semantics as the production bounded-out-of-orderness strategy, but advanced on every element. */
  private static WatermarkStrategy<StreamInput> punctuated(long boundMs) {
    return WatermarkStrategy.<StreamInput>forGenerator(ctx -> new WatermarkGenerator<StreamInput>() {
      long max = Long.MIN_VALUE + boundMs + 1;

      @Override
      public void onEvent(StreamInput in, long ts, WatermarkOutput out) {
        max = Math.max(max, TelemetryPipeline.timestampOf(in));
        out.emitWatermark(new Watermark(max - boundMs - 1));
      }

      @Override
      public void onPeriodicEmit(WatermarkOutput out) {}
    }).withTimestampAssigner((in, ts) -> TelemetryPipeline.timestampOf(in));
  }

  private static List<OutRecord> run(Config cfg, List<StreamInput> inputs) throws Exception {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    env.setParallelism(1);
    DataStream<StreamInput> in = env.fromData(inputs).assignTimestampsAndWatermarks(punctuated(cfg.maxOutOfOrderMs));
    List<OutRecord> out = new ArrayList<>();
    try (CloseableIterator<OutRecord> it = TelemetryPipeline.build(in, cfg).executeAndCollect()) {
      it.forEachRemaining(out::add);
    }
    return out;
  }

  private static StreamInput at(int tenant, int device, long id, long minute, Double t, Double h) {
    return input(event(tenant, device, id, T0 + minute * MIN, t, h));
  }

  private static JsonNode window(List<JsonNode> aggregates, int device, long startMinute, int revision) {
    for (JsonNode a : aggregates) {
      JsonNode p = a.get("payload");
      if (p.get("device_id").asText().equals(device(device))
          && p.get("window_start").asText().equals(iso(T0 + startMinute * MIN))
          && p.get("revision").asInt() == revision) {
        return a;
      }
    }
    return null;
  }

  @Test
  void slidingWindowsAggregateAndDropDuplicates() throws Exception {
    List<OutRecord> out = run(CFG, List.of(at(1, 1, 1, 1, 20.0, 50.0), at(1, 1, 1, 1, 20.0, 50.0), // duplicate
        at(1, 1, 2, 3, 22.0, null), at(1, 1, 3, 6, 24.0, 60.0)));
    List<JsonNode> aggs = ofType(out, DerivedEvents.AGGREGATE_TYPE);
    JsonNode w0 = window(aggs, 1, 0, 1); // [0,10): readings at m1, m3, m6
    assertNotNull(w0);
    assertEquals(3, w0.get("payload").get("reading_count").asInt(), "the duplicate is counted once");
    assertEquals(22.0, w0.get("payload").get("temperature_c").get("mean").asDouble());
    assertEquals(20.0, w0.get("payload").get("temperature_c").get("min").asDouble());
    assertEquals(24.0, w0.get("payload").get("temperature_c").get("max").asDouble());
    assertEquals(2, w0.get("payload").get("relative_humidity_percent").get("count").asInt());
    JsonNode wMinus5 = window(aggs, 1, -5, 1); // [-5,5): m1, m3
    assertEquals(2, wMinus5.get("payload").get("reading_count").asInt());
    JsonNode w5 = window(aggs, 1, 5, 1); // [5,15): m6
    assertEquals(1, w5.get("payload").get("reading_count").asInt());
    assertEquals(iso(T0 + 10 * MIN), w0.get("payload").get("window_end").asText());
    assertEquals(3, aggs.size(), "one aggregate per window");
  }

  @Test
  void lateEventWithinAllowedLatenessRefiresWithHigherRevision() throws Exception {
    List<OutRecord> out = run(CFG, List.of(at(1, 1, 1, 1, 20.0, null), at(1, 1, 2, 12, 20.0, null),
        at(1, 1, 3, 3, 26.0, null))); // m3 arrives after the watermark passed m11
    List<JsonNode> aggs = ofType(out, DerivedEvents.AGGREGATE_TYPE);
    JsonNode first = window(aggs, 1, 0, 1);
    JsonNode second = window(aggs, 1, 0, 2);
    assertNotNull(first);
    assertNotNull(second, "the window refires when late data is accepted");
    assertEquals(1, first.get("payload").get("reading_count").asInt());
    assertEquals(2, second.get("payload").get("reading_count").asInt());
    assertEquals(first.get("event_id").asText(), second.get("event_id").asText(), "same identity, higher revision");
    assertTrue(ofType(out, DerivedEvents.DLQ_TYPE).isEmpty());
  }

  @Test
  void eventBeyondAllowedLatenessGoesToTheDlq() throws Exception {
    List<OutRecord> out = run(CFG, List.of(at(1, 1, 1, 1, 20.0, null), at(1, 1, 2, 40, 20.0, null),
        at(1, 1, 3, 2, 26.0, null)));
    List<OutRecord> dlq = out.stream().filter(r -> r.eventType.equals(DerivedEvents.DLQ_TYPE)).toList();
    assertEquals(1, dlq.size());
    assertEquals("late", dlq.get(0).reason);
    assertEquals(tenant(1), dlq.get(0).tenantId);
    assertTrue(assertValid(dlq.get(0)).get("detail").asText().contains(uuid(3)));
    for (JsonNode a : ofType(out, DerivedEvents.AGGREGATE_TYPE)) {
      assertNotEquals(2, a.get("payload").get("reading_count").asInt() == 2
          && a.get("payload").get("temperature_c").get("max").asDouble() == 26.0 ? 2 : 0,
          "the late reading is not part of any aggregate");
    }
  }

  @Test
  void invalidInputIsQuarantinedWithReasonsAndNeverBlocksValidInput() throws Exception {
    String key = tenant(1) + ":" + device(1);
    String good = json(tenant(1), device(1), uuid(1), T0 + MIN, 20.0, null);
    List<OutRecord> out = run(CFG, List.of(raw(key, "{broken", 0), raw(tenant(2) + ":" + device(1), good, 1),
        raw(key, json(tenant(1), device(1), uuid(2), T0 + MIN, 500.0, null), 2), raw(key, good, 3)));
    List<OutRecord> dlq = out.stream().filter(r -> r.eventType.equals(DerivedEvents.DLQ_TYPE)).toList();
    assertEquals(List.of("bad_json", "key_mismatch", "bad_field"), dlq.stream().map(r -> r.reason).sorted(
        java.util.Comparator.comparing(r -> List.of("bad_json", "key_mismatch", "bad_field").indexOf(r))).toList());
    for (OutRecord r : dlq) {
      assertValid(r);
    }
    assertEquals(tenant(1), dlq.stream().filter(r -> r.reason.equals("key_mismatch")).findFirst().get().tenantId);
    assertFalse(ofType(out, DerivedEvents.AGGREGATE_TYPE).isEmpty(), "the valid reading still aggregates");
  }

  @Test
  void tenantsNeverMixEvenWithTheSameDeviceId() throws Exception {
    List<StreamInput> in = new ArrayList<>();
    for (int i = 0; i < 6; i++) {
      in.add(at(1, 1, 10 + i, i, 20.0, null));
      in.add(at(2, 1, 20 + i, i, 40.0, null)); // same device UUID under another tenant
    }
    in.add(at(1, 1, 99, 30, 20.0, null));
    in.add(at(2, 1, 98, 30, 40.0, null));
    List<JsonNode> aggs = ofType(run(CFG, in), DerivedEvents.AGGREGATE_TYPE);
    assertFalse(aggs.isEmpty());
    for (JsonNode a : aggs) {
      double mean = a.get("payload").get("temperature_c").get("mean").asDouble();
      assertEquals(a.get("tenant_id").asText().equals(tenant(1)) ? 20.0 : 40.0, mean,
          "an aggregate only ever contains its own tenant's readings");
    }
    assertEquals(2, aggs.stream().map(a -> a.get("tenant_id").asText()).distinct().count());
  }

  @Test
  void anomalyIsEmittedThroughThePipeline() throws Exception {
    List<StreamInput> in = new ArrayList<>();
    for (int i = 0; i < 12; i++) {
      in.add(at(1, 1, 100 + i, i, 20.0 + (i % 2) * 0.05, null));
    }
    in.add(at(1, 1, 200, 13, 28.0, null));
    in.add(at(1, 1, 201, 20, 20.0, null));
    List<JsonNode> an = ofType(run(CFG, in), DerivedEvents.ANOMALY_TYPE);
    assertEquals(1, an.size());
    assertTrue(an.get(0).get("payload").get("advisory").asBoolean());
    assertEquals(uuid(200), an.get(0).get("causation_id").asText());
  }

  @Test
  void rejectionsCarryTimestampZeroSoTheyNeverMoveTheWatermark() {
    StreamInput rejected = raw("k", "{x", 0);
    assertEquals(0L, TelemetryPipeline.timestampOf(rejected));
    assertEquals(T0, TelemetryPipeline.timestampOf(at(1, 1, 1, 0, 20.0, null)));
  }
}
