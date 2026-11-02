package com.greenguard.stream;

import java.io.Serializable;

/** Flink POJOs: public fields and a default constructor keep them on the fast POJO serializer, not Kryo. */
public final class Model {
  private Model() {}

  /** A validated canonical telemetry.recorded event. Event time is observedAtMs. */
  public static class TelemetryEvent implements Serializable {
    private static final long serialVersionUID = 1L;
    public String eventId;
    public String tenantId;
    public String deviceId;
    public String siteId;
    public String binId;
    public String readingId;
    public String correlationId;
    public String traceparent;
    public long observedAtMs;
    public long aggregateVersion;
    public Double temperatureC;
    public Double humidityPct;
    public String sourceTopic;
    public int sourcePartition;
    public long sourceOffset;

    public TelemetryEvent() {}

    /** Kafka key and Flink key: never spans tenants. */
    public String key() {
      return tenantId + ":" + deviceId;
    }
  }

  /** Input that failed validation. Bounded raw bytes only; tenant is a hint from a validated UUID. */
  public static class Rejection implements Serializable {
    private static final long serialVersionUID = 1L;
    public String reason;
    public String detail;
    public String sourceTopic;
    public int sourcePartition;
    public long sourceOffset;
    public String rawBase64;
    public boolean truncated;
    public String tenantHint;

    public Rejection() {}
  }

  /** Source element: exactly one of event or rejection is set. */
  public static class StreamInput implements Serializable {
    private static final long serialVersionUID = 1L;
    public TelemetryEvent event;
    public Rejection rejection;

    public StreamInput() {}
  }

  /** A record bound for Kafka, already serialized. */
  public static class OutRecord implements Serializable {
    private static final long serialVersionUID = 1L;
    public String topic;
    public String key;
    public String value;
    public String eventType;
    public String tenantId;
    public String traceparent;
    public String reason;

    public OutRecord() {}
  }

  /** Incremental sliding-window statistics for one device. */
  public static class WindowAcc implements Serializable {
    private static final long serialVersionUID = 1L;
    public int count;
    public long tempN;
    public double tempMin;
    public double tempMax;
    public double tempSum;
    public long humN;
    public double humMin;
    public double humMax;
    public double humSum;
    public long lastMs = Long.MIN_VALUE;
    public String lastEventId = "";
    public String lastCorrelation;
    public String lastTraceparent;
    public String tenantId;
    public String deviceId;
    public String siteId;
    public String binId;

    public WindowAcc() {}
  }

  /** EWMA baseline and last observation for one metric of one device. */
  public static class MetricState implements Serializable {
    private static final long serialVersionUID = 1L;
    public long n;
    public double mean;
    public double variance;
    public double lastValue;
    public long lastMs;
    public long lastEmitMs = Long.MIN_VALUE;
    public int consecutive;

    public MetricState() {}
  }

  public static class DetectorState implements Serializable {
    private static final long serialVersionUID = 1L;
    public MetricState temperature = new MetricState();
    public MetricState humidity = new MetricState();

    public DetectorState() {}
  }
}
