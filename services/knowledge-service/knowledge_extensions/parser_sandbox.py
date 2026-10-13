"""Bounded sandbox invocation and trusted reconstruction of parser results."""
from __future__ import annotations
import hashlib
import json
import subprocess
import tempfile
import selectors
import os
import time
from uuid import NAMESPACE_URL, uuid4, uuid5
from .pdf_parser import CanonicalChunk, ParsedPdf, PdfParseError, MAX_PDF_BYTES
from .outline import ParsedBlock, build_outline

MAX_OUTPUT=16*1024*1024

class ContainerPdfParser:
    def __init__(self, *, image: str, runtime: str='runsc', timeout: int=60, ocr: bool=False):
        if '@sha256:' not in image or runtime != 'runsc' or not 1 <= timeout <= 120:
            raise ValueError('parser requires a digest-pinned image and runsc runtime')
        if type(ocr) is not bool:
            raise ValueError("OCR flag must be boolean")
        self.ocr=ocr
        self.image=image
        self.timeout=timeout

    def parse(self, data: bytes, *, tenant_id: str, document_id: str, document_version: int) -> ParsedPdf:
        if not data.startswith(b'%PDF-') or not 8 <= len(data) <= MAX_PDF_BYTES:
            raise PdfParseError('input is not a bounded PDF')
        name='gg-parser-'+uuid4().hex
        command=['docker','run','--rm','-i','--name',name,'--runtime=runsc','--network=none',
                 '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                 '--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64',
                 '--user=10001:10001','--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
                 '--log-driver=none','--env','KNOWLEDGE_PARSER_OCR='+str(self.ocr).lower(),self.image,'python','parser_worker.py']
        try:
            payload=run_bounded(command,data,self.timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError('sandbox parser session exceeded its deadline') from exc
        finally:
            try:
                subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL,timeout=10)
            except (OSError,subprocess.SubprocessError):
                pass
        return bind_passages(payload,data=data,tenant_id=tenant_id,document_id=document_id,
                             document_version=document_version)

def run_bounded(command: list[str], data: bytes, timeout: int) -> bytes:
    with tempfile.TemporaryFile() as source:
        source.write(data)
        source.seek(0)
        with subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as process:
            deadline=time.monotonic()+timeout
            payload=bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        remaining=deadline-time.monotonic()
                        if remaining<=0:
                            raise subprocess.TimeoutExpired(command,timeout)
                        for key,_ in selector.select(remaining):
                            block=os.read(key.fd,min(65536,MAX_OUTPUT+1-len(payload)))
                            if not block:
                                selector.unregister(key.fileobj)
                            else:
                                payload.extend(block)
                                if len(payload)>MAX_OUTPUT:
                                    raise PdfParseError('sandbox parser exceeded output limit')
                result=process.wait(timeout=max(0.001,deadline-time.monotonic()))
                if result==65:
                    raise PdfParseError('sandbox parser rejected PDF')
                if result:
                    raise RuntimeError('sandbox runtime unavailable or parser terminated')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
    return bytes(payload)

def bind_passages(payload: bytes, *, data: bytes, tenant_id: str, document_id: str,
                  document_version: int) -> ParsedPdf:
    try:
        value=json.loads(payload)
        if set(value) != {'passages'} or not isinstance(value['passages'],list) or not 1<=len(value['passages'])<=2000:
            raise ValueError
        chunks=[]
        blocks=[]
        total=0
        previous=()
        for ordinal, passage in enumerate(value['passages']):
            if set(passage) != {'content','page_start','page_end','heading_path'}:
                raise ValueError
            content=passage['content']; start=passage['page_start']; end=passage['page_end']; path=passage['heading_path']
            if (not isinstance(content,str) or not 1<=len(content)<=12000 or type(start) is not int
                or type(end) is not int or not 1<=start<=end<=250 or not isinstance(path,list)
                or len(path)>6 or any(not isinstance(title,str) or not 1<=len(title)<=240 for title in path)):
                raise ValueError
            total+=len(content)
            if total>3_000_000:
                raise ValueError
            digest=hashlib.sha256(content.encode()).hexdigest()
            chunk_id=str(uuid5(NAMESPACE_URL,f'{tenant_id}:{document_id}:{document_version}:{ordinal}:{digest}'))
            if tuple(path)!=previous:
                common=0
                for old,new in zip(previous,path):
                    if old!=new:
                        break
                    common+=1
                if path and common==len(path) and len(path)<len(previous):
                    common-=1
                for level,title in enumerate(path[common:],common+1):
                    blocks.append(ParsedBlock('heading',title,start,end,heading_level=level))
                previous=tuple(path)
            chunks.append(CanonicalChunk(chunk_id,ordinal,content,digest,start,end,tuple(path)))
            blocks.append(ParsedBlock('chunk',content,start,end,chunk_id=chunk_id))
        outline=build_outline(tenant_id=tenant_id,document_id=document_id,
                              document_version=document_version,blocks=blocks)
        return ParsedPdf(tenant_id,document_id,document_version,hashlib.sha256(data).hexdigest(),tuple(chunks),outline)
    except (ValueError,TypeError,KeyError,AttributeError) as exc:
        raise PdfParseError('sandbox output failed validation') from exc
