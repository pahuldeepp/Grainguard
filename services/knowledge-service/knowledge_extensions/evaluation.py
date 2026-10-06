"""Deterministic RAG evaluation primitives; no vendor calls or semantic judge."""
from __future__ import annotations
import math
import re


def _ranking(ids: list[str], k: int) -> list[str]:
    if type(k) is not int or k < 1 or k > 100:
        raise ValueError("invalid evaluation cutoff")
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("rankings must contain unique nonempty IDs")
    return ids[:k]


def _labels(relevance: dict[str, int]) -> None:
    if not isinstance(relevance, dict) or not relevance or any(not isinstance(key, str) or not key or type(grade) is not int or not 0 <= grade <= 3 for key, grade in relevance.items()):
        raise ValueError("invalid relevance labels")


def recall_at_k(ids: list[str], relevance: dict[str, int], k: int) -> float:
    _labels(relevance)
    relevant = {key for key, grade in relevance.items() if grade > 0}
    if not relevant:
        raise ValueError("recall requires relevant labels")
    return len(set(_ranking(ids, k)) & relevant) / len(relevant)


def ndcg_at_k(ids: list[str], relevance: dict[str, int], k: int) -> float:
    _labels(relevance)
    ranked = _ranking(ids, k)
    ideal = sorted(relevance.values(), reverse=True)[:k]
    dcg = sum((2 ** relevance.get(item, 0) - 1) / math.log2(rank + 2) for rank, item in enumerate(ranked))
    idcg = sum((2 ** grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(ideal))
    if idcg == 0:
        raise ValueError("nDCG requires positive relevance")
    return dcg / idcg


def unsupported_numbers(answer: str, cited_texts: list[str]) -> list[str]:
    # A deterministic necessary support check, not a semantic entailment judge.
    # A matching number can still express a wrong relationship or unit.
    pattern = r"(?<!\w)[+-]?\d+(?:\.\d+)?(?:%|\b)"
    evidence = set(re.findall(pattern, " ".join(cited_texts)))
    return sorted(set(re.findall(pattern, answer)) - evidence)


def gate(report: dict, thresholds: dict) -> list[str]:
    failures = []
    for metric in ("recall_at_10", "ndcg_at_5", "citation_accuracy", "reference_fact_coverage"):
        threshold = thresholds.get(metric)
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
            return ["invalid_threshold_policy"]
    if any(type(thresholds.get(metric)) is not int or thresholds[metric] != 0 for metric in ("unsupported_numbers", "security_failures")):
        return ["invalid_threshold_policy"]
    for metric in ("recall_at_10", "ndcg_at_5", "citation_accuracy", "reference_fact_coverage"):
        value = report.get(metric)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1 or value < thresholds[metric]:
            failures.append(metric)
    for metric in ("unsupported_numbers", "security_failures"):
        value = report.get(metric)
        if type(value) is not int or value < 0 or value > thresholds[metric]:
            failures.append(metric)
    if "behavior_failures" in thresholds:
        if type(thresholds["behavior_failures"]) is not int or thresholds["behavior_failures"] != 0:
            return ["invalid_threshold_policy"]
        if type(report.get("behavior_failures")) is not int or report["behavior_failures"] != 0:
            failures.append("behavior_failures")
    if type(report.get("case_count")) is not int or report["case_count"] < 1:
        failures.append("empty_dataset")
    return failures
