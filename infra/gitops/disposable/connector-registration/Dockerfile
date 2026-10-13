FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
RUN apt-get update \
 && apt-get install --no-install-recommends -y postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin connector
WORKDIR /opt/connector-registration
COPY --chown=10001:10001 files/register.py ./register.py
COPY --chown=10001:10001 files/connectors ./connectors
USER 10001:10001
ENTRYPOINT ["python3", "/opt/connector-registration/register.py"]
