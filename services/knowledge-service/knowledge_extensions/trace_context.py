"""Bounded W3C context propagation without request content or identity attributes."""
from contextvars import ContextVar
from functools import wraps
import re

_current = ContextVar('knowledge_traceparent', default=None)
_PATTERN = re.compile(r'00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\Z')

def validated_traceparent(value):
    match = _PATTERN.fullmatch(value or '')
    return value if match and int(match[1], 16) and int(match[2], 16) else None

def incoming_trace_context(handler):
    @wraps(handler)
    def wrapped(self, *args, **kwargs):
        token = _current.set(validated_traceparent(self.headers.get('traceparent')))
        try:
            return handler(self, *args, **kwargs)
        finally:
            _current.reset(token)
    return wrapped

def outbound_trace_headers():
    value = _current.get()
    return {'traceparent': value} if value else {}
