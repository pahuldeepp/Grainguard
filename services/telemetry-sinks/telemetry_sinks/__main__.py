"""Container entry point. The Helm profile selects `clickhouse` or `s3-archive`."""

import logging
import os
import sys
import threading

from .runtime import install_signal_handlers, run


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if len(sys.argv) != 2 or sys.argv[1] not in {"clickhouse", "s3-archive"}:
        logging.error("usage: python -m telemetry_sinks {clickhouse|s3-archive}")
        return 2
    stop = threading.Event()
    install_signal_handlers(stop)
    try:
        run(sys.argv[1], stop_event=stop)
    except Exception as error:
        # Never print exception messages from Kafka, ClickHouse or AWS clients:
        # they may include credentials, query text, or telemetry payloads.
        logging.error("telemetry sink stopped after %s", type(error).__name__)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
