FROM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY services/ml-scoring/deploy/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    --requirement /tmp/requirements.lock \
    && groupadd --system --gid 10001 scorer \
    && useradd --system --uid 10001 --gid scorer --home-dir /nonexistent scorer \
    && rm -rf /root/.cache /tmp/requirements.lock

COPY --chown=10001:10001 services/ml-scoring/ml_scoring /app/ml_scoring
COPY --chown=10001:10001 ml/deep_learning/sequence_models.py /app/ml/deep_learning/sequence_models.py
COPY --chown=10001:10001 ml/deep_learning/comparison_contract.py /app/ml/deep_learning/comparison_contract.py
COPY --chown=10001:10001 evidence/model-registry/greenguard.hotspot-transition.classifier/i4-transformer-bcf286ab98d45f8c \
    /models/greenguard.hotspot-transition.classifier/i4-transformer-bcf286ab98d45f8c

RUN python -c "import ml_scoring.main; from ml.deep_learning.sequence_models import LSTMClassifier; print(LSTMClassifier.__name__)"

ENV PYTHONPATH=/app \
    ML_MODEL_REGISTRY_ROOT=/models

USER 10001:10001
ENTRYPOINT ["python", "-m", "ml_scoring.main"]
