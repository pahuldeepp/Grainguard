FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KNOWLEDGE_LISTEN_HOST=0.0.0.0
WORKDIR /app
COPY services/knowledge-service/requirements.lock.txt ./requirements.lock.txt
RUN pip install --no-cache-dir -r requirements.lock.txt && useradd --uid 10001 --create-home knowledge
COPY services/knowledge-service/knowledge_extensions/ ./knowledge_extensions/
COPY services/knowledge-service/serve.py services/knowledge-service/worker.py services/knowledge-service/summary_worker.py services/knowledge-service/migrate.py services/knowledge-service/migrate_rds.py ./
COPY services/knowledge-service/migrations/ ./migrations/
USER 10001
CMD ["python", "serve.py"]
