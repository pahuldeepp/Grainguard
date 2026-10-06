"""Bounded, deterministic checks for recognizable prompt-injection directives.

This heuristic is defense in depth, not a semantic safety guarantee. Callers
must still isolate untrusted passages and authorize every tool independently.
No submitted text is retained, logged, or included in exceptions.
"""
from __future__ import annotations

import re
import unicodedata

MAX_INSPECTION_CHARS = 1_000_000


def _normalize(text: str) -> str:
    # Cf covers zero-width format controls and bidi overrides. Other default
    # ignorables include combining grapheme joiner, variation selectors and
    # Hangul fillers; remove them without dropping ordinary combining accents.
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(
        char for char in text
        if unicodedata.category(char) != "Cf"
        and ord(char) not in {0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180F, 0x2065, 0x3164, 0xFFA0}
        and not 0x180B <= ord(char) <= 0x180D
        and not 0xFFF0 <= ord(char) <= 0xFFF8
        and not 0xFE00 <= ord(char) <= 0xFE0F
        and not 0xE0100 <= ord(char) <= 0xE01EF
    )


# Every wildcard is explicitly bounded. Code ordering defines stable verdicts.
_RULES = (
    ("instruction_override", (
        r"\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|these)\s+){0,3}(?:(?:previous|prior|above|earlier|system|developer|safety|original|citation)\s+){1,3}(?:instructions?|prompts?|rules?|polic(?:y|ies)|messages?|directions?)\b",
        r"\b(?:ignore|disregard|bypass|disable|override)\s+(?:(?:all|the|your)\s+){0,2}(?:guardrails|safety\s+checks|security\s+checks)\b",
        r"\b(?:do\s+not|don't|never)\s+(?:follow|obey)\s+(?:the\s+)?(?:system|developer|previous|prior)\s+(?:instructions?|prompts?|rules?)\b",
    )),
    ("role_spoofing", (
        r"(?:^|\n)\s*(?:system|developer|assistant)\s*:",
        r"\[\s*(?:system|developer|assistant)\s*\]|<\s*/?\s*(?:system|developer|assistant)(?:\s[^>\n]{0,80})?\s*>",
        r"\[/?inst\]|<<\s*/?sys\s*>>|<\|(?:im_start|im_end|start_header_id|end_header_id)\|>",
        r"\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(?:an?\s+)?(?:system|developer|unrestricted|unfiltered|jailbroken)\b",
    )),
    ("secret_exfiltration", (
        r"\b(?:reveal|print|show|disclose|return|output|repeat|leak|exfiltrate|export|send|upload|copy)\b[^\n.!?]{0,100}\b(?:hidden\s+instructions?|internal\s+policy\s+text|system\s+(?:prompt|instructions?|message)|developer\s+(?:prompt|instructions?|message)|api[ _-]?keys?|access[ _-]?tokens?|credentials?|passwords?|private[ _-]?keys?|environment\s+variables?|secrets?)\b",
    )),
    ("tool_directive", (
        r"\b(?:execute|run|invoke|call|use)\s+(?:(?:the|a|an|this|following)\s+){0,2}(?:shell|bash|powershell|terminal|python|curl|wget|subprocess|eval|exec)\b",
        r"\b(?:execute|invoke|call)\s+(?:(?:the|a|an|this|following)\s+){0,2}(?:tools?|functions?|commands?)\b",
        r"\b(?:execute|invoke|call)\s+(?:(?:the|a|an|this|following)\s+){0,2}[a-z_][a-z0-9_]{0,63}\s+(?:tool|function)\b",
        r"\b(?:send|upload|post|transmit|exfiltrate)\b[^\n.!?]{0,100}\b(?:conversation|chat\s+history|prompt|retrieved\s+(?:context|documents?)|document\s+contents?|tenant\s+data)\b[^\n.!?]{0,100}\b(?:https?://|webhook|endpoint|server|url)\b",
    )),
)
_COMPILED_RULES = tuple(
    (code, tuple(re.compile(pattern, re.MULTILINE) for pattern in patterns))
    for code, patterns in _RULES
)


class PromptInjectionError(ValueError):
    """Safe error carrying reason codes, never rejected input."""

    def __init__(self, reasons: tuple[str, ...]):
        self.reasons = reasons
        super().__init__("Text rejected by prompt-injection policy")


def inspect_text(text: str) -> tuple[str, ...]:
    """Return stable reason codes; fail closed on over-limit input."""
    if not isinstance(text, str):
        raise TypeError("Prompt-injection inspection requires text")
    if len(text) > MAX_INSPECTION_CHARS:
        return ("inspection_limit",)
    normalized = _normalize(text)
    if len(normalized) > MAX_INSPECTION_CHARS:
        return ("inspection_limit",)
    return tuple(
        code for code, patterns in _COMPILED_RULES
        if any(pattern.search(normalized) for pattern in patterns)
    )


def require_safe_text(text: str) -> None:
    """Reject recognizable injection instructions without echoing their text."""
    reasons = inspect_text(text)
    if reasons:
        raise PromptInjectionError(reasons)
