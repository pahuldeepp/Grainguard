package com.greenguard.stream;

import static com.greenguard.stream.TestData.*;
import static org.junit.jupiter.api.Assertions.*;

import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.StreamInput;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.util.Collector;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.junit.jupiter.api.Test;

class KafkaIoTest {
  private static List<StreamInput> deserialize(String key, String value) {
    List<StreamInput> out = new ArrayList<>();
    Collector<StreamInput> c = new Collector<>() {
      @Override public void collect(StreamInput r) { out.add(r); }
      @Override public void close() {}
    };
    new KafkaIo.Deserializer().deserialize(new ConsumerRecord<>("t", 3, 77L,
        key == null ? null : key.getBytes(StandardCharsets.UTF_8),
        value == null ? null : value.getBytes(StandardCharsets.UTF_8)), c);
    return out;
  }

  @Test
  void deserializerRecordsSourcePositionForEventsAndRejections() {
    StreamInput ok = deserialize(tenant(1) + ":" + device(1), json(tenant(1), device(1), uuid(1), T0, 20.0, null)).get(0);
    assertEquals(3, ok.event.sourcePartition);
    assertEquals(77, ok.event.sourceOffset);
    assertEquals("t", ok.event.sourceTopic);
    StreamInput bad = deserialize(tenant(1) + ":" + device(1), "{").get(0);
    assertEquals("bad_json", bad.rejection.reason);
    assertEquals(77, bad.rejection.sourceOffset);
    assertEquals("bad_json", deserialize("k", null).get(0).rejection.reason, "tombstone is quarantined");
    assertEquals("key_mismatch", deserialize(null, json(tenant(1), device(1), uuid(1), T0, 20.0, null)).get(0)
        .rejection.reason);
    assertNotNull(new KafkaIo.Deserializer().getProducedType());
  }

  @Test
  void serializerWritesKeyHeadersAndTopic() {
    OutRecord r = new OutRecord();
    r.topic = "out"; r.key = "k"; r.value = "v"; r.eventType = "telemetry.anomaly"; r.tenantId = tenant(1);
    r.traceparent = traceparent(); r.reason = "late";
    ProducerRecord<byte[], byte[]> p = new KafkaIo.Serializer().serialize(r, null, 1L);
    assertEquals("out", p.topic());
    assertEquals("k", new String(p.key(), StandardCharsets.UTF_8));
    Map<String, String> headers = new HashMap<>();
    p.headers().forEach(h -> headers.put(h.key(), new String(h.value(), StandardCharsets.UTF_8)));
    assertEquals(tenant(1), headers.get("tenant_id"));
    assertEquals("telemetry.anomaly", headers.get("event_type"));
    assertEquals("late", headers.get("reason"));
    assertEquals(traceparent(), headers.get("traceparent"));
    r.traceparent = null; r.reason = null;
    assertEquals(2, count(new KafkaIo.Serializer().serialize(r, null, 1L)));
  }

  private static int count(ProducerRecord<byte[], byte[]> p) {
    int n = 0;
    for (var ignored : p.headers()) { n++; }
    return n;
  }

  @Test
  void sourceSinkAndJobGraphBuildWithoutABroker() {
    for (String delivery : new String[] {"at-least-once", "exactly-once"}) {
      Config cfg = config(Map.of("SINK_DELIVERY", delivery, "STATE_BACKEND", "hashmap"));
      assertNotNull(KafkaIo.source(cfg));
      assertNotNull(KafkaIo.sink(cfg));
      StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
      Main.build(cfg, env);
      assertTrue(env.getStreamGraph().getStreamNodes().size() > 5);
      assertTrue(env.getCheckpointConfig().isCheckpointingEnabled());
      assertEquals(cfg.checkpointIntervalMs, env.getCheckpointInterval());
    }
  }

  @Test
  void rocksDbBackendIsSelectable() {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    Main.configure(env, config(Map.of("STATE_BACKEND", "rocksdb")));
    assertNotNull(env.getStateBackend());
    assertThrows(IllegalArgumentException.class, () -> Main.run(k -> null, env));
  }
}
