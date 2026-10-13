"""Shared transport policy for credential-bearing internal/provider requests."""
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, build_opener

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise URLError('credential-bearing HTTP redirects are disabled')

urlopen = build_opener(NoRedirect()).open
