package com.greenguard.stream;

import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.Rejection;
import com.greenguard.stream.Model.StreamInput;
import com.greenguard.stream.Model.TelemetryEvent;
import com.greenguard.stream.Operators.DeviceKey;
import java.time.Duration;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.DataStreamUtils;
import org.apache.flink.streaming.api.datastream.KeyedStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.windowing.assigners.SlidingEventTimeWindows;

/** Wires parse, dedupe, sliding aggregates, anomaly detection and the DLQ. Input must carry timestamps and watermarks. */
public final class TelemetryPipeline {
  private TelemetryPipeline() {}

  /** Production watermarking: per-partition bounded out-of-orderness with idleness, applied at the source. */
  public static WatermarkStrategy<StreamInput> watermarks(Config cfg) {
    return WatermarkStrategy.<StreamInput>forBoundedOutOfOrderness(Duration.ofMillis(cfg.maxOutOfOrderMs))
        .withTimestampAssigner((in, ts) -> timestampOf(in)).withIdleness(Duration.ofMillis(cfg.idleTimeoutMs));
  }

  /** Rejections get timestamp 0 so they can never advance a watermark. */
  static long timestampOf(StreamInput in) {
    return in.event != null ? in.event.observedAtMs : 0L;
  }

  public static DataStream<OutRecord> build(DataStream<StreamInput> input, Config cfg) {
    SingleOutputStreamOperator<TelemetryEvent> events =
        input.process(new Operators.SplitInput()).name("split-input").uid("split-input");
    DataStream<OutRecord> dlq = events.getSideOutput(Operators.REJECTED)
        .map(new RejectionToDlq(cfg.dlqTopic)).name("dlq-rejected").uid("dlq-rejected");

    SingleOutputStreamOperator<TelemetryEvent> deduped = events.keyBy(new DeviceKey())
        .process(new Operators.Dedupe(cfg.dedupeTtlMs)).name("dedupe").uid("dedupe");
    // Dedupe preserves the key partitioning, so the later keyed operators skip a second network shuffle.
    KeyedStream<TelemetryEvent, String> keyed = DataStreamUtils.reinterpretAsKeyedStream(deduped, new DeviceKey());

    SingleOutputStreamOperator<OutRecord> aggregates = keyed
        .window(SlidingEventTimeWindows.of(Duration.ofMillis(cfg.windowSizeMs), Duration.ofMillis(cfg.windowSlideMs)))
        .allowedLateness(Duration.ofMillis(cfg.allowedLatenessMs)).sideOutputLateData(Operators.LATE)
        .aggregate(new Operators.StatsAggregate(),
            new Operators.EmitWindow(cfg.aggregateTopic, cfg.windowSizeMs, cfg.windowSlideMs))
        .name("sliding-aggregate").uid("sliding-aggregate");
    DataStream<OutRecord> late = aggregates.getSideOutput(Operators.LATE).map(new LateToDlq(cfg.dlqTopic))
        .name("dlq-late").uid("dlq-late");

    DataStream<OutRecord> anomalies = DataStreamUtils.reinterpretAsKeyedStream(deduped, new DeviceKey())
        .process(new Operators.AnomalyDetector(cfg.detector, cfg.anomalyTopic)).name("anomaly").uid("anomaly");

    return aggregates.union(anomalies, dlq, late);
  }

  static final class RejectionToDlq implements MapFunction<Rejection, OutRecord> {
    private static final long serialVersionUID = 1L;
    private final String topic;

    RejectionToDlq(String topic) {
      this.topic = topic;
    }

    @Override
    public OutRecord map(Rejection r) {
      return DerivedEvents.dlq(topic, r);
    }
  }

  static final class LateToDlq implements MapFunction<TelemetryEvent, OutRecord> {
    private static final long serialVersionUID = 1L;
    private final String topic;

    LateToDlq(String topic) {
      this.topic = topic;
    }

    @Override
    public OutRecord map(TelemetryEvent e) {
      return DerivedEvents.late(topic, e);
    }
  }
}
