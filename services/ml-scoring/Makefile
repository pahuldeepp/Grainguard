# Standalone entry point for the isolated three-broker acceptance harness.
ROOT := ../..
PYTHON ?= $(abspath $(ROOT)/.local/ml-scoring-venv/bin/python)
.PHONY: failure-acceptance-test failure-acceptance-unit-test
failure-acceptance-test:
	cd $(ROOT) && PYTHONPATH=services/ml-scoring:services/risk-engine:services/grain-advisor:.:packages/ml-features/src:packages/grain-physics/src $(PYTHON) services/ml-scoring/failure_acceptance.py
failure-acceptance-unit-test:
	cd $(ROOT) && PYTHONPATH=services/ml-scoring:services/risk-engine:services/grain-advisor:.:packages/ml-features/src:packages/grain-physics/src $(PYTHON) -m unittest discover -s services/ml-scoring/tests -p 'test_failure_acceptance.py' -v
