"""confluent-kafka adapter for the consumer's Source interface.

Manual commits only, synchronously, one record at a time and only after the caller's
durable effect. ``auto.offset.reset=error`` (the default here) makes a lost or expired
committed offset a hard failure instead of silently skipping to earliest/latest,
matching the Go transformer's NoResetOffset stance. A brand-new consumer group must be
started once with an explicit RISK_KAFKA_OFFSET_RESET=earliest.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from risk_engine.apply import Record

_TIMEOUT_S = 10.0


class KafkaError(RuntimeError):
    """Broker, fetch or commit failure; the process must stop without committing."""


def _default_factory(config: Mapping[str, Any]) -> Any:
    from confluent_kafka import Consumer  # imported only by the live runner

    return Consumer(dict(config))


def _default_partition(topic: str, partition: int, offset: int = -1001) -> Any:
    from confluent_kafka import TopicPartition

    return TopicPartition(topic, partition, offset)


class KafkaSource:
    def __init__(self, bootstrap: str, group: str, topics: tuple[str, ...], offset_reset: str = "error",
                 factory: Callable[[Mapping[str, Any]], Any] = _default_factory,
                 partition: Callable[..., Any] = _default_partition):
        if offset_reset not in ("error", "earliest"):
            raise ValueError("offset reset must be error or earliest")
        self._partition = partition
        self._consumer = factory({
            "bootstrap.servers": bootstrap, "group.id": group, "enable.auto.commit": False,
            "enable.auto.offset.store": False, "auto.offset.reset": offset_reset,
            "isolation.level": "read_committed",
        })
        self._consumer.subscribe(list(topics))

    def poll(self, timeout_s: float) -> Record | None:
        message = self._consumer.poll(timeout_s)
        if message is None:
            return None
        if message.error():
            raise KafkaError(f"Kafka poll failed: {message.error()}")
        return Record(message.topic(), message.partition(), message.offset(), message.value())

    def commit(self, record: Record) -> None:
        committed = self._consumer.commit(
            offsets=[self._partition(record.topic, record.partition, record.offset + 1)], asynchronous=False)
        if not committed or any(item.error for item in committed):
            raise KafkaError(f"Kafka offset commit failed: {committed}")

    def rewind_and_pause(self, record: Record) -> None:
        target = self._partition(record.topic, record.partition, record.offset)
        self._consumer.pause([target])
        self._consumer.seek(target)

    def resume(self, topic: str, partition: int) -> None:
        self._consumer.resume([self._partition(topic, partition)])

    def _partitions(self, topic: str) -> list[int]:
        metadata = self._consumer.list_topics(topic, timeout=_TIMEOUT_S)
        return sorted(metadata.topics[topic].partitions)

    def high_watermarks(self, topic: str) -> Mapping[int, int]:
        marks = {}
        for number in self._partitions(topic):
            _, high = self._consumer.get_watermark_offsets(
                self._partition(topic, number), timeout=_TIMEOUT_S, cached=False)
            marks[number] = high
        return marks

    def committed(self, topic: str) -> Mapping[int, int]:
        partitions = [self._partition(topic, number) for number in self._partitions(topic)]
        return {item.partition: max(item.offset, 0)
                for item in self._consumer.committed(partitions, timeout=_TIMEOUT_S)}

    def close(self) -> None:
        self._consumer.close()
