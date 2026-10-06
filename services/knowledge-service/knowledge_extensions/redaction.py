"""Bounded, deterministic AI egress redaction; originals remain private canonical data.

Policy v1 deliberately covers recognizable credentials and contact information,
not arbitrary names, addresses or every secret format. Never log matched values.
"""
import re
import unicodedata

MAX_TEXT = 2_000_000
RULES = (
    ('PRIVATE_KEY', r"(?s)-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----.*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$)"),
    ('SECRET', r"(?i)\b(?:sk-(?:ant-)?|pcsk_)[a-z0-9_-]{16,}"),
    ('SECRET', r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    ('SECRET', r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    ('SECRET', r"(?i)\b(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret|authorization)\s*[:=]\s*[\"\x27]?(?:Bearer\s+)?[^\s\"\x27,;]{4,}"),
    ('SECRET', r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*"),
    ('EMAIL', r"(?i)\b[a-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b"),
    ('PHONE', r"\b[2-9][0-9]{2}[-. ][2-9][0-9]{2}[-. ][0-9]{4}\b"),
)
_COMPILED = tuple((kind, re.compile(pattern)) for kind, pattern in RULES)


def _normalise(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text) if unicodedata.category(c) != "Cf")


def redact_text(text: str) -> str:
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise ValueError("redaction input exceeds policy bounds")
    text = _normalise(text)
    for kind, pattern in _COMPILED:
        text = pattern.sub("[REDACTED_" + kind + "]", text)
    return text


def redact_passages(texts: list[str]) -> list[str]:
    # A private key may span canonical chunks. Fail closed for the entire
    # embedding/context batch rather than leaking the intervening key body.
    if any(not isinstance(text, str) or len(text) > MAX_TEXT for text in texts):
        raise ValueError("redaction input exceeds policy bounds")
    texts = [_normalise(text) for text in texts]
    if any("PRIVATE KEY-----" in text for text in texts):
        return ["[REDACTED_PRIVATE_KEY]" for _ in texts]
    return [redact_text(text) for text in texts]
