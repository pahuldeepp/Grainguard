import unittest
from unittest.mock import patch
from knowledge_extensions.file_validation import ClamAvScanner,ScanUnavailable
from knowledge_extensions.pdf_parser import PdfParseError
class Socket:
    def __init__(self,response): self.response=response; self.sent=[]
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def settimeout(self,value): pass
    def sendall(self,data): self.sent.append(data)
    def recv(self,size):
        result=self.response; self.response=b''; return result
class ScanTests(unittest.TestCase):
    def test_clean_verdict_and_stream_framing(self):
        sock=Socket(b'stream: OK\x00')
        with patch('socket.create_connection',return_value=sock):
            ClamAvScanner(host='scanner').scan(b'%PDF-test')
        self.assertEqual(sock.sent[0],b'zINSTREAM\x00')
        self.assertEqual(sock.sent[-1],b'\x00\x00\x00\x00')
    def test_malware_and_missing_verdict_fail_closed(self):
        for response,error in [(b'stream: Eicar FOUND\x00',PdfParseError),(b'ERROR\x00',ScanUnavailable)]:
            with patch('socket.create_connection',return_value=Socket(response)):
                with self.assertRaises(error): ClamAvScanner(host='scanner').scan(b'%PDF-test')
