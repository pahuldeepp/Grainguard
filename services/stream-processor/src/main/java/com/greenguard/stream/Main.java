package com.greenguard.stream;

import com.greenguard.stream.Model.StreamInput;
import java.time.Duration;
import java.util.function.Function;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.contrib.streaming.state.EmbeddedRocksDBStateBackend;
import org.apache.flink.runtime.state.hashmap.HashMapStateBackend;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.CheckpointConfig;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

/** Entry point. Takes the environment as a parameter so configuration is testable. */
public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    run(System::getenv, StreamExecutionEnvironment.getExecutionEnvironment());
  }

  static void run(Function<String, String> getenv, StreamExecutionEnvironment env) throws Exception {
    build(Config.from(getenv), env);
    env.execute("greenguard-telemetry-stream");
  }

  /** Builds the job graph without executing it. */
  static void build(Config cfg, StreamExecutionEnvironment env) {
    configure(env, cfg);
    DataStream<StreamInput> source = env
        .fromSource(KafkaIo.source(cfg), TelemetryPipeline.watermarks(cfg), "telemetry-recorded")
        .uid("telemetry-source").setParallelism(cfg.parallelism);
    TelemetryPipeline.build(source, cfg).sinkTo(KafkaIo.sink(cfg)).uid("kafka-sink").name("derived-topics");
  }

  static void configure(StreamExecutionEnvironment env, Config cfg) {
    env.setParallelism(cfg.parallelism);
    env.enableCheckpointing(cfg.checkpointIntervalMs, CheckpointingMode.EXACTLY_ONCE);
    CheckpointConfig cp = env.getCheckpointConfig();
    cp.setCheckpointStorage(cfg.checkpointDir);
    cp.setMinPauseBetweenCheckpoints(Math.max(1_000, cfg.checkpointIntervalMs / 2));
    cp.setCheckpointTimeout(Duration.ofMinutes(2).toMillis());
    cp.setTolerableCheckpointFailureNumber(3);
    cp.setMaxConcurrentCheckpoints(1);
    cp.setExternalizedCheckpointCleanup(CheckpointConfig.ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION);
    env.setStateBackend("rocksdb".equals(cfg.stateBackend) ? new EmbeddedRocksDBStateBackend(true)
        : new HashMapStateBackend());
    env.setRestartStrategy(RestartStrategies.exponentialDelayRestart(Time.seconds(1), Time.seconds(60), 2.0,
        Time.minutes(10), 0.1));
  }
}
