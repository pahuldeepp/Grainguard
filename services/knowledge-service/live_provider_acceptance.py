"""Synthetic PDF → live providers probe; no AWS. Requires --execute."""
import argparse,json,sys,time,os
from pathlib import Path
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).parent/'tests'))
from pdf_fixture import make_text_pdf
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.model_gateway import ModelGatewayClient,verified_gateway_user
from knowledge_extensions.vector_store import PineconeVectorStore,VectorRecord

def main():
 p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');args=p.parse_args()
 if not args.execute:p.error('--execute required for live provider calls')
 secret=Path(os.environ.get('GREENGUARD_SECRETS_DIR',str(Path.home()/'.config/greenguard/secrets')))
 tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 g=ModelGatewayClient(base_url='http://127.0.0.1:18089',task_token=(secret/'gateway-caller-token').read_text().strip(),timeout_seconds=40)
 index=json.loads((secret/'pinecone-index.json').read_text())
 v=PineconeVectorStore(index_host=index['host'],api_key=(secret/'pinecone-api-key').read_text().strip())
 namespace='synthetic-acceptance-'+uuid4().hex
 pdf=parse_pdf(make_text_pdf([['Grain storage','Store wheat dry and ventilate it to reduce mold risk.']]),tenant_id=tenant,document_id=str(uuid4()),document_version=1)
 chunks=list(pdf.chunks);ids=[c.chunk_id for c in chunks];uploaded=False
 try:
  embeddings=g.embed([c.content for c in chunks],tenant_id=tenant,model='embed-v1',input_type='passage')
  assert all(len(x)==1024 for x in embeddings)
  v.upsert(namespace=namespace,records=[VectorRecord(c.chunk_id,tuple(x),{'doc_id':pdf.document_id,'doc_version':1,'tenant_ref':'synthetic','trust':'curated','acl_scope':'synthetic','embedding_version':'embed-v1','tombstone':False}) for c,x in zip(chunks,embeddings)])
  uploaded=True
  q='How can I reduce wheat mold risk?'
  with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'):
   query=g.embed([q],tenant_id=tenant,model='embed-v1',input_type='query')[0]
  for _ in range(20):
   hits=v.search(namespace=namespace,vector=query,top_k=5)
   if hits:break
   time.sleep(1)
  assert hits and all(h.chunk_id in ids for h in hits)
  by_id={c.chunk_id:c for c in chunks};retrieved=[by_id[h.chunk_id] for h in hits]
  with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'):
   ranking=g.rerank(q,[c.content for c in retrieved],tenant_id=tenant,model='rerank-v1',top_n=1);c=retrieved[ranking[0]]
  print('PASS: PDFium/chunks → Voyage embeddings → Pinecone upsert/search → Voyage rerank',flush=True)
  with verified_gateway_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'):
   answer=g.answer(q,[{'chunk_id':c.chunk_id,'trust':'curated','text':c.content}],tenant_id=tenant,model='answer-v1')
  assert answer['cited_chunk_ids']==[c.chunk_id]
  print('PASS: Claude answer with validated citation')
 finally:
  if uploaded:
   v.delete(namespace=namespace,chunk_ids=ids);print('Synthetic vectors deleted',flush=True)
if __name__=='__main__':main()
