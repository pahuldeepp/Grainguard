# Build from the repository root: docker build -f services/risk-engine/Dockerfile .
FROM python@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/risk-engine/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/risk-engine/risk_engine ./risk_engine
COPY services/risk-engine/migrations ./migrations
RUN useradd --system --uid 10001 risk
USER 10001
FROM base AS migration
COPY scripts/verify-migration-url.py /app/verify-migration-url.py
ENTRYPOINT ["sh", "-ec", "python /app/verify-migration-url.py RISK_MIGRATION_URL && python -m risk_engine.migrate"]
FROM base AS runtime
EXPOSE 8086
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8086/healthz', timeout=2)"
ENTRYPOINT ["python", "-m", "risk_engine.main"]
