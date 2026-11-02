package com.greenguard.stream;

import com.greenguard.stream.Config.DetectorSettings;
import com.greenguard.stream.Model.DetectorState;
import com.greenguard.stream.Model.MetricState;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.StreamInput;
import com.greenguard.stream.Model.TelemetryEvent;
import com.greenguard.stream.Model.WindowAcc;
import java.util.ArrayList;
import java.util.List;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.api.java.functions.KeySelector;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.streaming.api.functions.windowing.ProcessWindowFunction;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

/** Flink operators. Every keyed operator is keyed by tenant:device, so state never spans tenants. */
public final class Operators {
  public static final OutputTag<Model.Rejection> REJECTED = new OutputTag<Model.Rejection>("rejected") {};
  public static final OutputTag<TelemetryEvent> LATE = new OutputTag<TelemetryEvent>("late") {};

  private Operators() {}

  public static final class DeviceKey implements KeySelector<TelemetryEvent, String> {
    private static final long serialVersionUID = 1L;

    @Override
    public String getKey(TelemetryEvent e) {
      return e.key();
    }
  }

  /** Splits parsed input into events and rejections; counts both. Metric labels are reasons only. */
  public static final class SplitInput extends ProcessFunction<StreamInput, TelemetryEvent> {
    private static final long serialVersionUID = 1L;
    private transient Counter received;

    @Override
    public void open(OpenContext ctx) {
      received = getRuntimeContext().getMetricGroup().counter("greenguard_events_in");
    }

    @Override
    public void processElement(StreamInput in, Context ctx, Collector<TelemetryEvent> out) {
      received.inc();
      if (in.event != null) {
        out.collect(in.event);
        return;
      }
      getRuntimeContext().getMetricGroup().addGroup("reason", in.rejection.reason).counter("greenguard_rejected")
          .inc();
      ctx.output(REJECTED, in.rejection);
    }
  }

  /** Drops an event_id already seen for the device within the TTL. */
  public static final class Dedupe extends KeyedProcessFunction<String, TelemetryEvent, TelemetryEvent> {
    private static final long serialVersionUID = 1L;
    private final long ttlMs;
    private transient MapState<String, Boolean> seen;
    private transient Counter duplicates;

    public Dedupe(long ttlMs) {
      this.ttlMs = ttlMs;
    }

    @Override
    public void open(OpenContext ctx) {
      MapStateDescriptor<String, Boolean> d = new MapStateDescriptor<>("seen-event-ids", String.class, Boolean.class);
      d.enableTimeToLive(StateTtlConfig.newBuilder(Time.milliseconds(ttlMs))
          .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
          .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired).build());
      seen = getRuntimeContext().getMapState(d);
      duplicates = getRuntimeContext().getMetricGroup().counter("greenguard_duplicates");
    }

    @Override
    public void processElement(TelemetryEvent e, Context ctx, Collector<TelemetryEvent> out) throws Exception {
      if (seen.contains(e.eventId)) {
        duplicates.inc();
        return;
      }
      seen.put(e.eventId, Boolean.TRUE);
      out.collect(e);
    }
  }

  public static final class StatsAggregate implements AggregateFunction<TelemetryEvent, WindowAcc, WindowAcc> {
    private static final long serialVersionUID = 1L;

    @Override
    public WindowAcc createAccumulator() {
      return new WindowAcc();
    }

    @Override
    public WindowAcc add(TelemetryEvent e, WindowAcc a) {
      if (a.count == 0) {
        a.tenantId = e.tenantId;
        a.deviceId = e.deviceId;
        a.siteId = e.siteId;
        a.binId = e.binId;
      }
      a.count++;
      if (e.temperatureC != null) {
        double v = e.temperatureC;
        a.tempMin = a.tempN == 0 ? v : Math.min(a.tempMin, v);
        a.tempMax = a.tempN == 0 ? v : Math.max(a.tempMax, v);
        a.tempSum += v;
        a.tempN++;
      }
      if (e.humidityPct != null) {
        double v = e.humidityPct;
        a.humMin = a.humN == 0 ? v : Math.min(a.humMin, v);
        a.humMax = a.humN == 0 ? v : Math.max(a.humMax, v);
        a.humSum += v;
        a.humN++;
      }
      takeLast(a, e.observedAtMs, e.eventId, e.correlationId, e.traceparent, e.siteId, e.binId);
      return a;
    }

    /** The latest event wins; ties break on event_id so the result is order-independent. */
    private static void takeLast(WindowAcc a, long ms, String id, String correlation, String trace, String site,
        String bin) {
      if (ms > a.lastMs || (ms == a.lastMs && id.compareTo(a.lastEventId) > 0)) {
        a.lastMs = ms;
        a.lastEventId = id;
        a.lastCorrelation = correlation;
        a.lastTraceparent = trace;
        a.siteId = site;
        a.binId = bin;
      }
    }

    @Override
    public WindowAcc getResult(WindowAcc a) {
      return a;
    }

    @Override
    public WindowAcc merge(WindowAcc x, WindowAcc y) {
      if (x.count == 0) {
        return y;
      }
      if (y.count == 0) {
        return x;
      }
      x.count += y.count;
      if (y.tempN > 0) {
        x.tempMin = x.tempN == 0 ? y.tempMin : Math.min(x.tempMin, y.tempMin);
        x.tempMax = x.tempN == 0 ? y.tempMax : Math.max(x.tempMax, y.tempMax);
        x.tempSum += y.tempSum;
        x.tempN += y.tempN;
      }
      if (y.humN > 0) {
        x.humMin = x.humN == 0 ? y.humMin : Math.min(x.humMin, y.humMin);
        x.humMax = x.humN == 0 ? y.humMax : Math.max(x.humMax, y.humMax);
        x.humSum += y.humSum;
        x.humN += y.humN;
      }
      takeLast(x, y.lastMs, y.lastEventId, y.lastCorrelation, y.lastTraceparent, y.siteId, y.binId);
      return x;
    }
  }

  /** Emits one aggregate per firing; a refiring caused by accepted late data bumps the revision. */
  public static final class EmitWindow extends ProcessWindowFunction<WindowAcc, OutRecord, String, TimeWindow> {
    private static final long serialVersionUID = 1L;
    private final String topic;
    private final long sizeMs;
    private final long slideMs;
    private transient Counter emitted;
    private transient Counter refired;

    public EmitWindow(String topic, long sizeMs, long slideMs) {
      this.topic = topic;
      this.sizeMs = sizeMs;
      this.slideMs = slideMs;
    }

    @Override
    public void open(OpenContext ctx) {
      emitted = getRuntimeContext().getMetricGroup().counter("greenguard_aggregates_emitted");
      refired = getRuntimeContext().getMetricGroup().counter("greenguard_aggregates_refired");
    }

    @Override
    public void process(String key, Context ctx, Iterable<WindowAcc> in, Collector<OutRecord> out) throws Exception {
      ValueState<Integer> state = ctx.windowState().getState(new ValueStateDescriptor<>("revision", Integer.class));
      int revision = state.value() == null ? 1 : state.value() + 1;
      state.update(revision);
      emitted.inc();
      if (revision > 1) {
        refired.inc();
      }
      out.collect(DerivedEvents.aggregate(topic, in.iterator().next(), ctx.window().getStart(), ctx.window().getEnd(),
          sizeMs, slideMs, revision));
    }
  }

  /**
   * Per-device anomaly detector. Events are buffered and released in event-time order when the watermark passes
   * them, so out-of-order arrival inside the watermark bound cannot change detector state. An event already behind
   * the watermark cannot be ordered and is skipped here (it can still reach a window within allowed lateness).
   */
  public static final class AnomalyDetector extends KeyedProcessFunction<String, TelemetryEvent, OutRecord> {
    private static final long serialVersionUID = 1L;
    private final DetectorSettings s;
    private final String topic;
    private transient MapState<Long, List<TelemetryEvent>> buffer;
    private transient ValueState<DetectorState> state;
    private transient Counter zscore;
    private transient Counter rapid;
    private transient Counter skippedLate;

    public AnomalyDetector(DetectorSettings settings, String topic) {
      this.s = settings;
      this.topic = topic;
    }

    @Override
    public void open(OpenContext ctx) {
      buffer = getRuntimeContext().getMapState(new MapStateDescriptor<>("anomaly-buffer", Types.LONG,
          Types.LIST(TypeInformation.of(TelemetryEvent.class))));
      state = getRuntimeContext().getState(new ValueStateDescriptor<>("detector", DetectorState.class));
      zscore = getRuntimeContext().getMetricGroup().addGroup("detector", "zscore").counter("greenguard_anomalies");
      rapid = getRuntimeContext().getMetricGroup().addGroup("detector", "rapid_change")
          .counter("greenguard_anomalies");
      skippedLate = getRuntimeContext().getMetricGroup().counter("greenguard_anomaly_skipped_late");
    }

    @Override
    public void processElement(TelemetryEvent e, Context ctx, Collector<OutRecord> out) throws Exception {
      if (e.observedAtMs <= ctx.timerService().currentWatermark()) {
        skippedLate.inc();
        return;
      }
      List<TelemetryEvent> at = buffer.get(e.observedAtMs);
      if (at == null) {
        at = new ArrayList<>();
      }
      at.add(e);
      buffer.put(e.observedAtMs, at);
      ctx.timerService().registerEventTimeTimer(e.observedAtMs);
    }

    /** Timers fire in ascending timestamp order, so each call releases exactly one timestamp's events. */
    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<OutRecord> out) throws Exception {
      List<TelemetryEvent> ready = buffer.get(timestamp);
      if (ready == null) {
        return;
      }
      ready.sort(java.util.Comparator.comparing((TelemetryEvent e) -> e.eventId));
      DetectorState ds = state.value() == null ? new DetectorState() : state.value();
      for (TelemetryEvent e : ready) {
        if (e.temperatureC != null) {
          observe(e, "temperature_c", e.temperatureC, ds.temperature, s.tempRatePerMin, 0.1, out);
        }
        if (e.humidityPct != null) {
          observe(e, "relative_humidity_percent", e.humidityPct, ds.humidity, s.humidityRatePerMin, 0.5, out);
        }
      }
      buffer.remove(timestamp);
      state.update(ds);
    }

    private void observe(TelemetryEvent e, String metric, double v, MetricState m, double ratePerMin, double sdFloor,
        Collector<OutRecord> out) {
      double sd = Math.max(Math.sqrt(m.variance), sdFloor);
      boolean emitted = false;
      if (m.n > 0 && e.observedAtMs > m.lastMs) {
        long gap = e.observedAtMs - m.lastMs;
        double rate = Math.abs(v - m.lastValue) / (gap / 60_000d);
        if (gap <= s.rapidMaxGapMs && rate >= ratePerMin && cooledDown(m, e.observedAtMs)) {
          out.collect(DerivedEvents.anomaly(topic, e, metric, "rapid_change", v, m.mean, sd, rate));
          rapid.inc();
          m.lastEmitMs = e.observedAtMs;
          emitted = true;
        }
      }
      boolean outlier = false;
      if (m.n >= s.minSamples) {
        double z = (v - m.mean) / sd;
        outlier = Math.abs(z) >= s.zscore;
        if (outlier && !emitted && cooledDown(m, e.observedAtMs)) {
          out.collect(DerivedEvents.anomaly(topic, e, metric, "zscore", v, m.mean, sd, z));
          zscore.inc();
          m.lastEmitMs = e.observedAtMs;
        }
      }
      learn(m, v, outlier, sdFloor);
      m.lastValue = v;
      m.lastMs = Math.max(m.lastMs, e.observedAtMs);
    }

    private boolean cooledDown(MetricState m, long ms) {
      return m.lastEmitMs == Long.MIN_VALUE || ms - m.lastEmitMs >= s.cooldownMs;
    }

    /** Outliers do not pollute the baseline, but a sustained shift is relearned after relearnAfter readings. */
    private void learn(MetricState m, double v, boolean outlier, double sdFloor) {
      if (m.n == 0) {
        m.mean = v;
        m.variance = 0;
        m.n = 1;
        return;
      }
      if (outlier) {
        m.consecutive++;
        if (m.consecutive >= s.relearnAfter) {
          m.mean = v;
          m.variance = sdFloor * sdFloor;
          m.n = s.minSamples;
          m.consecutive = 0;
        }
        return;
      }
      m.consecutive = 0;
      double delta = v - m.mean;
      m.mean += s.alpha * delta;
      m.variance = (1 - s.alpha) * (m.variance + s.alpha * delta * delta);
      m.n++;
    }
  }
}
