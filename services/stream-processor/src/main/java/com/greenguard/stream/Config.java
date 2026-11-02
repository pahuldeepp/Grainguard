package com.greenguard.stream;

import java.io.Serializable;
import java.time.Duration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Job configuration read from the environment; entry points take a getenv function so tests need no process env. */
public final class Config implements Serializable {
  private static final long serialVersionUID = 1L;
  private static final Pattern SIMPLE_DURATION = Pattern.compile("^(\\d+)(ms|s|m|h)$");
  private static final String PROP_PREFIX = "KAFKA_PROP_";

  public final String brokers;
  public final String inputTopic;
  public final String aggregateTopic;
  public final String anomalyTopic;
  public final String dlqTopic;
  public final String groupId;
  public final int parallelism;
  public final long maxOutOfOrderMs;
  public final long idleTimeoutMs;
  public final long allowedLatenessMs;
  public final long windowSizeMs;
  public final long windowSlideMs;
  public final long dedupeTtlMs;
  public final long checkpointIntervalMs;
  public final String checkpointDir;
  public final String stateBackend;
  public final boolean exactlyOnceSink;
  public final String transactionalIdPrefix;
  public final DetectorSettings detector;
  public final Map<String, String> kafkaProps;

  private Config(Function<String, String> env) {
    brokers = required(env, "KAFKA_BROKERS");
    inputTopic = str(env, "INPUT_TOPIC", "greenguard.telemetry.recorded.v1");
    aggregateTopic = str(env, "TOPIC_AGGREGATE", "greenguard.telemetry.aggregate.v1");
    anomalyTopic = str(env, "TOPIC_ANOMALY", "greenguard.telemetry.anomaly.v1");
    dlqTopic = str(env, "TOPIC_DLQ", "greenguard.stream.dlq.v1");
    groupId = str(env, "GROUP_ID", "greenguard-flink-telemetry-v1");
    parallelism = positive(intValue(env, "PARALLELISM", 2), "PARALLELISM");
    maxOutOfOrderMs = positive(dur(env, "MAX_OUT_OF_ORDER", "2m"), "MAX_OUT_OF_ORDER");
    idleTimeoutMs = positive(dur(env, "IDLE_TIMEOUT", "30s"), "IDLE_TIMEOUT");
    allowedLatenessMs = dur(env, "ALLOWED_LATENESS", "10m");
    windowSizeMs = positive(dur(env, "WINDOW_SIZE", "15m"), "WINDOW_SIZE");
    windowSlideMs = positive(dur(env, "WINDOW_SLIDE", "1m"), "WINDOW_SLIDE");
    dedupeTtlMs = positive(dur(env, "DEDUPE_TTL", "24h"), "DEDUPE_TTL");
    checkpointIntervalMs = positive(dur(env, "CHECKPOINT_INTERVAL", "10s"), "CHECKPOINT_INTERVAL");
    checkpointDir = str(env, "CHECKPOINT_DIR", "file:///tmp/greenguard-flink/checkpoints");
    stateBackend = oneOf(str(env, "STATE_BACKEND", "hashmap"), "STATE_BACKEND", "hashmap", "rocksdb");
    exactlyOnceSink = oneOf(str(env, "SINK_DELIVERY", "at-least-once"), "SINK_DELIVERY", "at-least-once", "exactly-once")
        .equals("exactly-once");
    transactionalIdPrefix = str(env, "TRANSACTIONAL_ID_PREFIX", "greenguard-flink-telemetry");
    if (windowSlideMs > windowSizeMs || windowSizeMs % windowSlideMs != 0) {
      throw new IllegalArgumentException("WINDOW_SIZE must be a whole multiple of WINDOW_SLIDE");
    }
    detector = new DetectorSettings(
        dbl(env, "ANOMALY_ALPHA", 0.05), positiveD(dbl(env, "ANOMALY_ZSCORE", 4.0), "ANOMALY_ZSCORE"),
        positive(intValue(env, "ANOMALY_MIN_SAMPLES", 30), "ANOMALY_MIN_SAMPLES"),
        positive(dur(env, "ANOMALY_COOLDOWN", "5m"), "ANOMALY_COOLDOWN"),
        positiveD(dbl(env, "ANOMALY_TEMP_RATE_C_PER_MIN", 5.0), "ANOMALY_TEMP_RATE_C_PER_MIN"),
        positiveD(dbl(env, "ANOMALY_HUMIDITY_RATE_PCT_PER_MIN", 10.0), "ANOMALY_HUMIDITY_RATE_PCT_PER_MIN"),
        positive(dur(env, "ANOMALY_RAPID_MAX_GAP", "10m"), "ANOMALY_RAPID_MAX_GAP"),
        positive(intValue(env, "ANOMALY_RELEARN_AFTER", 10), "ANOMALY_RELEARN_AFTER"));
    if (!(detector.alpha > 0 && detector.alpha <= 1)) { // also rejects NaN
      throw new IllegalArgumentException("ANOMALY_ALPHA must be in (0, 1]");
    }
    kafkaProps = new HashMap<>();
    // KAFKA_PROP_SECURITY_PROTOCOL=SASL_SSL becomes security.protocol=SASL_SSL (TLS/SASL pass-through).
    for (String name : propertyNames(env)) {
      kafkaProps.put(name.substring(PROP_PREFIX.length()).toLowerCase(Locale.ROOT).replace('_', '.'), env.apply(name));
    }
  }

  public static Config from(Function<String, String> env) {
    return new Config(env);
  }

  /** Names of pass-through variables; a getenv function cannot be enumerated, so the supported keys are listed. */
  private static Iterable<String> propertyNames(Function<String, String> env) {
    String[] known = {"SECURITY_PROTOCOL", "SASL_MECHANISM", "SASL_JAAS_CONFIG", "SSL_TRUSTSTORE_LOCATION",
        "SSL_TRUSTSTORE_PASSWORD", "SSL_KEYSTORE_LOCATION", "SSL_KEYSTORE_PASSWORD", "SSL_KEY_PASSWORD",
        "SSL_ENDPOINT_IDENTIFICATION_ALGORITHM", "CLIENT_ID"};
    java.util.List<String> present = new java.util.ArrayList<>();
    for (String k : known) {
      if (env.apply(PROP_PREFIX + k) != null) {
        present.add(PROP_PREFIX + k);
      }
    }
    return present;
  }

  static long parseDuration(String raw, String name) {
    String s = raw.trim();
    if (s.regionMatches(true, 0, "P", 0, 1)) {
      try {
        return Duration.parse(s.toUpperCase(Locale.ROOT)).toMillis();
      } catch (RuntimeException e) {
        throw new IllegalArgumentException(name + " is not a valid duration: " + raw);
      }
    }
    Matcher m = SIMPLE_DURATION.matcher(s);
    if (!m.matches()) {
      throw new IllegalArgumentException(name + " must look like 30s, 2m, 24h or PT2M: " + raw);
    }
    long n = Long.parseLong(m.group(1));
    switch (m.group(2)) {
      case "ms": return n;
      case "s": return n * 1_000;
      case "m": return n * 60_000;
      default: return n * 3_600_000;
    }
  }

  private static String required(Function<String, String> env, String name) {
    String v = env.apply(name);
    if (v == null || v.isBlank()) {
      throw new IllegalArgumentException(name + " is required");
    }
    return v.trim();
  }

  private static String str(Function<String, String> env, String name, String def) {
    String v = env.apply(name);
    return v == null || v.isBlank() ? def : v.trim();
  }

  private static long dur(Function<String, String> env, String name, String def) {
    return parseDuration(str(env, name, def), name);
  }

  private static int intValue(Function<String, String> env, String name, int def) {
    try {
      return Integer.parseInt(str(env, name, Integer.toString(def)));
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(name + " must be an integer");
    }
  }

  private static double dbl(Function<String, String> env, String name, double def) {
    try {
      return Double.parseDouble(str(env, name, Double.toString(def)));
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(name + " must be a number");
    }
  }

  private static String oneOf(String v, String name, String... allowed) {
    for (String a : allowed) {
      if (a.equals(v)) {
        return v;
      }
    }
    throw new IllegalArgumentException(name + " must be one of " + String.join(", ", allowed));
  }

  private static int positive(int v, String name) {
    if (v <= 0) {
      throw new IllegalArgumentException(name + " must be positive");
    }
    return v;
  }

  private static long positive(long v, String name) {
    if (v <= 0) {
      throw new IllegalArgumentException(name + " must be positive");
    }
    return v;
  }

  private static double positiveD(double v, String name) {
    if (!(v > 0) || Double.isInfinite(v)) {
      throw new IllegalArgumentException(name + " must be positive");
    }
    return v;
  }

  /** Anomaly detector tuning; advisory signals only, never alert thresholds. */
  public static final class DetectorSettings implements Serializable {
    private static final long serialVersionUID = 1L;
    public final double alpha;
    public final double zscore;
    public final int minSamples;
    public final long cooldownMs;
    public final double tempRatePerMin;
    public final double humidityRatePerMin;
    public final long rapidMaxGapMs;
    public final int relearnAfter;

    public DetectorSettings(double alpha, double zscore, int minSamples, long cooldownMs, double tempRatePerMin,
        double humidityRatePerMin, long rapidMaxGapMs, int relearnAfter) {
      this.alpha = alpha;
      this.zscore = zscore;
      this.minSamples = minSamples;
      this.cooldownMs = cooldownMs;
      this.tempRatePerMin = tempRatePerMin;
      this.humidityRatePerMin = humidityRatePerMin;
      this.rapidMaxGapMs = rapidMaxGapMs;
      this.relearnAfter = relearnAfter;
    }
  }
}
