package com.greenguard.stream;

import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.StreamInput;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema;
import org.apache.flink.util.Collector;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.OffsetResetStrategy;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.internals.RecordHeader;

/** Kafka source and sink construction. Builders do not connect; tests build them without a broker. */
public final class KafkaIo {
  private KafkaIo() {}

  /** Parses at the source so per-partition watermarks see only validated event times. */
  public static final class Deserializer implements KafkaRecordDeserializationSchema<StreamInput> {
    private static final long serialVersionUID = 1L;

    @Override
    public void deserialize(ConsumerRecord<byte[], byte[]> r, Collector<StreamInput> out) {
      String key = r.key() == null ? null : new String(r.key(), StandardCharsets.UTF_8);
      String value = r.value() == null ? null : new String(r.value(), StandardCharsets.UTF_8);
      TelemetryParser.Result res = TelemetryParser.parse(key, value);
      StreamInput in = new StreamInput();
      if (res.event != null) {
        in.event = res.event;
        in.event.sourceTopic = r.topic();
        in.event.sourcePartition = r.partition();
        in.event.sourceOffset = r.offset();
      } else {
        in.rejection = TelemetryParser.rejection(res.reason, res.detail, r.topic(), r.partition(), r.offset(),
            r.value());
      }
      out.collect(in);
    }

    @Override
    public TypeInformation<StreamInput> getProducedType() {
      return TypeInformation.of(StreamInput.class);
    }
  }

  /** Writes key, value and routing headers. The tenant header is a hint for ACL-scoped consumers. */
  public static final class Serializer implements KafkaRecordSerializationSchema<OutRecord> {
    private static final long serialVersionUID = 1L;

    @Override
    public ProducerRecord<byte[], byte[]> serialize(OutRecord r, KafkaSinkContext ctx, Long timestamp) {
      List<org.apache.kafka.common.header.Header> headers = new ArrayList<>();
      headers.add(new RecordHeader("event_type", bytes(r.eventType)));
      headers.add(new RecordHeader("tenant_id", bytes(r.tenantId)));
      if (r.traceparent != null) {
        headers.add(new RecordHeader("traceparent", bytes(r.traceparent)));
      }
      if (r.reason != null) {
        headers.add(new RecordHeader("reason", bytes(r.reason)));
      }
      return new ProducerRecord<>(r.topic, null, null, bytes(r.key), bytes(r.value), headers);
    }

    private static byte[] bytes(String s) {
      return s.getBytes(StandardCharsets.UTF_8);
    }
  }

  public static KafkaSource<StreamInput> source(Config cfg) {
    Properties props = new Properties();
    props.putAll(cfg.kafkaProps);
    props.setProperty("partition.discovery.interval.ms", "60000");
    return KafkaSource.<StreamInput>builder().setBootstrapServers(cfg.brokers).setTopics(cfg.inputTopic)
        .setGroupId(cfg.groupId)
        .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetResetStrategy.EARLIEST))
        .setDeserializer(new Deserializer()).setProperties(props).build();
  }

  public static KafkaSink<OutRecord> sink(Config cfg) {
    Properties props = new Properties();
    props.setProperty("compression.type", "lz4");
    props.setProperty("linger.ms", "20");
    props.setProperty("batch.size", "131072");
    props.putAll(cfg.kafkaProps);
    if (cfg.exactlyOnceSink) {
      // Must stay below the broker's transaction.max.timeout.ms (15 minutes by default).
      props.setProperty("transaction.timeout.ms", "600000");
    }
    return KafkaSink.<OutRecord>builder().setBootstrapServers(cfg.brokers).setRecordSerializer(new Serializer())
        .setDeliveryGuarantee(cfg.exactlyOnceSink ? DeliveryGuarantee.EXACTLY_ONCE : DeliveryGuarantee.AT_LEAST_ONCE)
        .setTransactionalIdPrefix(cfg.transactionalIdPrefix).setKafkaProducerConfig(props).build();
  }
}
