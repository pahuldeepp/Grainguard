"""Strict service origins for explicit mesh mTLS deployments."""
from urllib.parse import urlsplit


def owner_origin_allowed(origin, *, mesh_authority, allow_mesh_http=False):
    value = urlsplit(origin or '')
    if (not value.hostname or value.username or value.password or value.query or value.fragment
            or value.path not in {'', '/'}):
        return False
    if value.scheme == 'https':
        return True
    if value.scheme == 'http' and value.hostname in {'127.0.0.1', 'localhost', '::1'}:
        return True
    return allow_mesh_http is True and value.scheme == 'http' and value.netloc == mesh_authority
