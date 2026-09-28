# Build from repository root. The consuming index version is a deployment value.
FROM python@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/search-indexer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/search-indexer/search_indexer.py ./search_indexer.py
RUN useradd --system --uid 10001 indexer
USER 10001
ENTRYPOINT ["python", "/app/search_indexer.py"]
