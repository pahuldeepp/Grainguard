"""Network-free parser entry point: bytes in, bounded passage data out, no identities."""
import json
import os
import sys
import resource
from knowledge_extensions.outline import InvalidOutline
from knowledge_extensions.pdf_parser import MAX_PDF_BYTES, PdfParseError, parse_pdf

def main():
    resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
    data=sys.stdin.buffer.read(MAX_PDF_BYTES+1)
    ocr = None
    if os.environ.get("KNOWLEDGE_PARSER_OCR") == "true":
        from knowledge_extensions.pdf_ocr import tesseract_page
        ocr = tesseract_page
    parsed=parse_pdf(data,tenant_id='00000000-0000-4000-8000-000000000001',
                     document_id='00000000-0000-4000-8000-000000000002',document_version=1,ocr=ocr)
    json.dump({'passages':[{'content':c.content,'page_start':c.page_start,
                           'page_end':c.page_end,'heading_path':list(c.heading_path)}
                          for c in parsed.chunks]},sys.stdout,ensure_ascii=True)

if __name__=='__main__':
    try:
        main()
    except (PdfParseError,InvalidOutline):
        sys.exit(65)
