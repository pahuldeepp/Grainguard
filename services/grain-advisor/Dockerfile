FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ADVISOR_HTTP_HOST=0.0.0.0 \
    ADVISOR_HTTP_PORT=8088
WORKDIR /workspace
COPY services/grain-advisor/requirements.txt ./services/grain-advisor/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r services/grain-advisor/requirements.txt \
    && useradd --uid 10001 --create-home advisor
COPY services/grain-advisor/advisor_security/ ./services/grain-advisor/advisor_security/
COPY services/grain-advisor/serve_delegated.py services/grain-advisor/agent_workflow.py ./services/grain-advisor/
COPY services/grain-advisor/migrate_security.py services/grain-advisor/migrate_rds.py services/grain-advisor/workflow_checkpoint_migrate.py ./services/grain-advisor/
COPY services/grain-advisor/migrations/ ./services/grain-advisor/migrations/
COPY ai/policy/tools.yaml ./ai/policy/tools.yaml
ENV PYTHONPATH=/workspace/services/grain-advisor
USER 10001:10001
EXPOSE 8088
CMD ["python", "services/grain-advisor/serve_delegated.py"]
