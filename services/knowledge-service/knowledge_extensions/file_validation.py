"""Fail-closed ClamAV INSTREAM scan before any PDFium invocation."""
import socket
import struct
from .pdf_parser import PdfParseError, MAX_PDF_BYTES

class ScanUnavailable(RuntimeError): pass

class ClamAvScanner:
    def __init__(self, *, host: str, port: int=3310, timeout: int=30):
        self.host=host; self.port=port; self.timeout=timeout
    def scan(self,data: bytes) -> None:
        if not data.startswith(b'%PDF-') or not 8<=len(data)<=MAX_PDF_BYTES:
            raise PdfParseError('input is not a bounded PDF')
        try:
            with socket.create_connection((self.host,self.port),timeout=self.timeout) as sock:
                sock.settimeout(self.timeout)
                sock.sendall(b'zINSTREAM\x00')
                for offset in range(0,len(data),65536):
                    block=data[offset:offset+65536]
                    sock.sendall(struct.pack('!I',len(block))+block)
                sock.sendall(b'\x00\x00\x00\x00')
                response=bytearray()
                while len(response)<=4096:
                    block=sock.recv(512)
                    if not block: break
                    response.extend(block)
                    if b'\x00' in block: break
            result=bytes(response).rstrip(b'\x00\n')
            if result==b'stream: OK': return
            if result.endswith(b' FOUND'):
                raise PdfParseError('file rejected by malware scan')
            raise ScanUnavailable('malware scanner returned no clean verdict')
        except OSError as exc:
            raise ScanUnavailable('malware scanner unavailable') from exc
