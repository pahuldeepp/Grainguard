"""Bounded answer contract and static output safety checks; no raw diagnostics."""
from .prompt_guardrails import inspect_text
from .redaction import redact_text

ABSTENTION = "I couldn't find sufficient evidence in the authorized source passages to answer that."
MAX_ANSWER = 12000

class OutputContractError(ValueError):
    """Model response cannot be safely mapped to authorized citations."""


def validate_answer(value: object, allowed_ids: set[str], max_citations: int) -> tuple[str, list[str]]:
    if not isinstance(value, dict) or set(value) != {'answer', 'cited_chunk_ids'}:
        raise OutputContractError('invalid answer schema')
    answer, cited = value['answer'], value['cited_chunk_ids']
    if (not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER
            or not isinstance(cited, list) or len(cited) > max_citations
            or any(not isinstance(item, str) or item not in allowed_ids for item in cited)
            or len(set(cited)) != len(cited)):
        raise OutputContractError('invalid answer schema or citations')
    if not cited or inspect_text(answer):
        return ABSTENTION, []
    safe = redact_text(answer.strip())
    if len(safe) > MAX_ANSWER or inspect_text(safe):
        return ABSTENTION, []
    return safe, cited
