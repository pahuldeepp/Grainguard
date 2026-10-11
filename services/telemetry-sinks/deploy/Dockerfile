# Build from repository root: docker build -f services/telemetry-sinks/deploy/Dockerfile .
FROM python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 EVENT_SCHEMA_DIR=/contracts/events
WORKDIR /app
COPY services/telemetry-sinks/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.lock \
    && useradd --system --uid 10001 --create-home telemetry-sinks
COPY services/telemetry-sinks/telemetry_sinks ./telemetry_sinks
COPY contracts/events/telemetry-recorded.v1.schema.json /contracts/events/telemetry-recorded.v1.schema.json
COPY contracts/events/telemetry-recorded.v2.schema.json /contracts/events/telemetry-recorded.v2.schema.json
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python", "-m", "telemetry_sinks"]
