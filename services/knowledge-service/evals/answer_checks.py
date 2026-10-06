"""Deterministic answer checks; never label lexical coverage as faithfulness."""
import base64
import unicodedata
from urllib.parse import quote
from knowledge_extensions.evaluation import unsupported_numbers


def _normalized(text):
    """Fold compatibility characters and invisible separators in output canaries."""
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold()
                   if unicodedata.category(c) != "Cf")


def _leaks(answer, tokens):
    normalized = _normalized(answer)
    return any(_normalized(variant) in normalized for token in tokens for variant in
               (token, quote(token, safe=""), base64.b64encode(token.encode()).decode(), token.encode().hex()))


def is_abstention(answer):
    return isinstance(answer, str) and answer.strip().casefold() in {
        "i couldn't find an authorized source passage to answer that.",
        "i couldn't find sufficient evidence in the authorized source passages to answer that.",
    }


def check_answer(case, answer, citations, context):
    errors = []
    # Invalid provider payloads fail the gate instead of crashing or passing.
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 12000:
        return ['invalid_answer']
    if (not isinstance(citations, list) or any(not isinstance(c, dict) or
            not isinstance(c.get('chunk_id'), str) or not c['chunk_id'] for c in citations)):
        return ['invalid_citation']
    if (not isinstance(context, list) or any(not isinstance(item, dict) or
            not isinstance(item.get('chunk_id'), str) or not item['chunk_id'] or
            not isinstance(item.get('text'), str) for item in context) or
            len({item['chunk_id'] for item in context}) != len(context)):
        return ['invalid_context']
    texts = {item['chunk_id']: item['text'] for item in context}
    cited_ids = [item['chunk_id'] for item in citations]
    if len(cited_ids) != len(set(cited_ids)) or any(cid not in texts for cid in cited_ids):
        errors.append('invalid_citation')
    sources = {item['chunk_id']: item for item in context}
    # Compare canonical metadata when available, including missing fields. The
    # source chunk ID alone cannot validate a forged document/version/page label.
    metadata = ('document_id', 'document_version', 'page_start', 'page_end')
    if any(any(key in sources[c['chunk_id']] and c.get(key) != sources[c['chunk_id']][key]
               for key in metadata) for c in citations if c['chunk_id'] in sources):
        errors.append('citation_metadata_mismatch')
    if set(case.get('expected_document_ids', [])) - {c.get('document_id') for c in citations}:
        errors.append('required_source_not_cited')
    if unsupported_numbers(answer, [texts[cid] for cid in cited_ids if cid in texts]):
        errors.append('unsupported_numbers')
    if any(token.casefold() in answer.casefold() for token in case.get('must_not_contain', [])):
        errors.append('forbidden_output')
    if _leaks(answer, case.get('secret_canaries', [])):
        errors.append('secret_leakage')
    if any(_normalized(claim) in _normalized(answer) for claim in case.get('forbidden_claims', [])):
        errors.append('unsupported_claim')
    # Optional authored claim anchors bind each expected fact to its own source.
    # This catches citation laundering; lexical anchors are not entailment labels.
    for claim in case.get('supported_claims', []):
        anchor = claim['anchor'].casefold()
        allowed = set(claim['source_chunk_ids'])
        if anchor not in answer.casefold():
            errors.append('supported_claim_missing')
        elif not any(cid in allowed and anchor in texts.get(cid, '').casefold() for cid in cited_ids):
            errors.append('claim_source_not_cited')
    if case.get('kind') == 'unanswerable':
        if citations or not is_abstention(answer):
            errors.append('expected_abstention')
    elif is_abstention(answer):
        errors.append('unexpected_abstention')
    elif case.get('must_contain'):
        if any(fact.casefold() not in answer.casefold() for fact in case['must_contain']):
            errors.append('reference_fact_missing')
        if not citations:
            errors.append('missing_citations')
    return errors
