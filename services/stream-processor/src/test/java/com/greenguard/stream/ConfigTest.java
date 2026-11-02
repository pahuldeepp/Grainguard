package com.greenguard.stream;

import static org.junit.jupiter.api.Assertions.*;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ConfigTest {
  private static Map<String, String> base() {
    Map<String, String> m = new HashMap<>();
    m.put("KAFKA_BROKERS", "kafka:29092");
    return m;
  }

  private static Config cfg(Map<String, String> m) {
    return Config.from(m::get);
  }

  @Test
  void defaultsMatchTheAdr() {
    Config c = cfg(base());
    assertEquals("greenguard.telemetry.recorded.v1", c.inputTopic);
    assertEquals("greenguard.telemetry.aggregate.v1", c.aggregateTopic);
    assertEquals("greenguard.telemetry.anomaly.v1", c.anomalyTopic);
    assertEquals("greenguard.stream.dlq.v1", c.dlqTopic);
    assertEquals(120_000, c.maxOutOfOrderMs);
    assertEquals(600_000, c.allowedLatenessMs);
    assertEquals(15 * 60_000, c.windowSizeMs);
    assertEquals(60_000, c.windowSlideMs);
    assertEquals(24 * 3_600_000L, c.dedupeTtlMs);
    assertEquals(10_000, c.checkpointIntervalMs);
    assertEquals("hashmap", c.stateBackend);
    assertFalse(c.exactlyOnceSink);
  }

  @Test
  void durationsAcceptSimpleAndIso() {
    assertEquals(1500, Config.parseDuration("1500ms", "x"));
    assertEquals(30_000, Config.parseDuration("30s", "x"));
    assertEquals(120_000, Config.parseDuration("PT2M", "x"));
    assertEquals(120_000, Config.parseDuration("pt2m", "x"));
    assertEquals(7_200_000, Config.parseDuration("2h", "x"));
    assertThrows(IllegalArgumentException.class, () -> Config.parseDuration("soon", "x"));
    assertThrows(IllegalArgumentException.class, () -> Config.parseDuration("PTbad", "x"));
  }

  @Test
  void overridesAndKafkaPassThrough() {
    Map<String, String> m = base();
    m.put("STATE_BACKEND", "rocksdb");
    m.put("SINK_DELIVERY", "exactly-once");
    m.put("PARALLELISM", "6");
    m.put("KAFKA_PROP_SECURITY_PROTOCOL", "SASL_SSL");
    m.put("KAFKA_PROP_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM", "https");
    Config c = cfg(m);
    assertEquals("rocksdb", c.stateBackend);
    assertTrue(c.exactlyOnceSink);
    assertEquals(6, c.parallelism);
    assertEquals("SASL_SSL", c.kafkaProps.get("security.protocol"));
    assertEquals("https", c.kafkaProps.get("ssl.endpoint.identification.algorithm"));
  }

  @Test
  void identifierCaseConversionIgnoresTheDefaultLocale() {
    java.util.Locale previous = java.util.Locale.getDefault();
    try {
      java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr-TR"));
      Map<String, String> m = base();
      m.put("KAFKA_PROP_SECURITY_PROTOCOL", "SSL");
      m.put("WINDOW_SIZE", "pt15m");
      Config c = cfg(m);
      assertEquals("SSL", c.kafkaProps.get("security.protocol"));
      assertEquals(15 * 60_000, c.windowSizeMs);
    } finally {
      java.util.Locale.setDefault(previous);
    }
  }

  @Test
  void invalidSettingsFailClosed() {
    String[][] bad = {{"KAFKA_BROKERS", " "}, {"WINDOW_SIZE", "10m", "WINDOW_SLIDE", "3m"},
        {"WINDOW_SLIDE", "30m"}, {"STATE_BACKEND", "memory"}, {"SINK_DELIVERY", "maybe"}, {"PARALLELISM", "0"},
        {"PARALLELISM", "two"}, {"ANOMALY_ALPHA", "1.5"}, {"ANOMALY_ZSCORE", "0"}, {"ANOMALY_ALPHA", "x"}, {"ANOMALY_ALPHA", "NaN"}, {"ANOMALY_ZSCORE", "NaN"},
        {"MAX_OUT_OF_ORDER", "0s"}, {"ANOMALY_MIN_SAMPLES", "-1"}};
    for (String[] pairs : bad) {
      Map<String, String> m = base();
      for (int i = 0; i < pairs.length; i += 2) {
        m.put(pairs[i], pairs[i + 1]);
      }
      assertThrows(IllegalArgumentException.class, () -> cfg(m), String.join(",", pairs));
    }
    assertThrows(IllegalArgumentException.class, () -> cfg(new HashMap<>()));
  }
}
