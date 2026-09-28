FROM python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/eventbridge-bridge/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/eventbridge-bridge/bridge.py ./bridge.py
COPY services/eventbridge-bridge/worker_health.py ./worker_health.py
USER 10001:10001
ENTRYPOINT ["python", "/app/bridge.py"]
