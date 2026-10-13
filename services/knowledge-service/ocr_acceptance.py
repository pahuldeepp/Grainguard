"""Real scanned-PDF OCR in a network-free Docker container (local synthetic only).

Docker Desktop's local runtime is not evidence of Linux gVisor isolation.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
import zlib
import pypdfium2 as pdfium
sys.path.insert(0,str(Path(__file__).parent/'tests'))
from pdf_fixture import make_text_pdf
from knowledge_extensions.pdf_parser import parse_pdf,PdfParseError
from knowledge_extensions.parser_sandbox import bind_passages


def make_scanned():
    text=make_text_pdf([['SYNTHETIC STORAGE PROCEDURE','Inspect the bin before filling.','Record the checkpoint after inspection.']])
    document=pdfium.PdfDocument(text);page=document[0];bitmap=page.render(scale=2,grayscale=True)
    try:
        raw=bytes(bitmap.buffer)
        raster=b''.join(raw[y*bitmap.stride:y*bitmap.stride+bitmap.width] for y in range(bitmap.height))
        width,height=bitmap.width,bitmap.height
    finally:bitmap.close();page.close();document.close()
    image=zlib.compress(raster)
    content=b'q 612 0 0 792 0 0 cm /Im0 Do Q'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
        f'<< /Length {len(content)} >>\nstream\n'.encode()+content+b'\nendstream',
        f'<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {len(image)} >>\nstream\n'.encode()+image+b'\nendstream']
    output=bytearray(b'%PDF-1.4\n');offsets=[0]
    for i,obj in enumerate(objects,1):offsets.append(len(output));output.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
    start=len(output);output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:output.extend(f'{offset:010d} 00000 n \n'.encode())
    output.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'.encode())
    return bytes(output)


def main():
    if os.environ.get('KNOWLEDGE_ENVIRONMENT')!='local-synthetic':raise SystemExit('local-synthetic only')
    data=make_scanned()
    try:parse_pdf(data,tenant_id='11111111-1111-4111-8111-111111111111',document_id='33333333-3333-4333-8333-333333333333',document_version=1)
    except PdfParseError:pass
    else:raise AssertionError('fixture must have no text layer')
    result=subprocess.run(['docker','run','--rm','-i','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
        '--memory=512m','--cpus=1','--pids-limit=64','--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
        '--env','KNOWLEDGE_PARSER_OCR=true','greenguard-parser:ocr-local'],input=data,capture_output=True,timeout=120,check=True)
    parsed=bind_passages(result.stdout,data=data,tenant_id='11111111-1111-4111-8111-111111111111',document_id='33333333-3333-4333-8333-333333333333',document_version=1)
    text=' '.join(c.content for c in parsed.chunks)
    assert 'Inspect the bin before filling' in text and 'Record the checkpoint' in text
    report=dict(real_scanned_pdf=True,original_text_layer=False,network_free_container=True,
        canonical_ocr_chunks=len(parsed.chunks),page_metadata=[c.page_start for c in parsed.chunks],
        expected_facts_found=True,gvisor_linux_validation=False)
    out=Path('evidence/intelligence/summary-quality-local');out.mkdir(parents=True,exist_ok=True)
    (out/'synthetic-scanned-procedure.pdf').write_bytes(data)
    (out/'ocr-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':main()
