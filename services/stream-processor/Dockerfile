# Build context: repository root (docker build -f services/stream-processor/Dockerfile .)
# maven:3.9-eclipse-temurin-17 and flink:1.20.1-java17, pinned by index digest.
FROM maven@sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584 AS build
WORKDIR /src/services/stream-processor
COPY services/stream-processor/pom.xml ./pom.xml
RUN mvn -B -q dependency:go-offline -DskipTests
COPY services/stream-processor/src ./src
# Tests run in CI/make flink-test; the image build only packages.
RUN mvn -B -q package -DskipTests -Djacoco.skip=true

FROM flink@sha256:d51a693da76581f2483d3f83d5997d3226b076a9f990a7f7d1eed144434b8e1e
USER root
# The Prometheus metrics reporter already ships in /opt/flink/plugins/metrics-prometheus.
RUN mkdir -p /opt/flink/usrlib /checkpoints && chown -R flink:flink /opt/flink/usrlib /checkpoints
COPY --from=build --chown=flink:flink /src/services/stream-processor/target/stream-processor.jar /opt/flink/usrlib/stream-processor.jar
USER flink
