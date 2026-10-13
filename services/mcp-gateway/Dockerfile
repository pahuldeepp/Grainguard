FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY services/mcp-gateway/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt
COPY services/mcp-gateway/gateway.py ./gateway.py
COPY services/mcp-gateway/owner_worker.py ./owner_worker.py
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=1).read()"]
ENTRYPOINT ["python", "/app/gateway.py"]
