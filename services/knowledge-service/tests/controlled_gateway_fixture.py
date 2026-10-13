"""Actual Go gateway + Redis + Postgres accounting, with synthetic providers."""
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time
from urllib.request import urlopen

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from knowledge_extensions.model_gateway import ModelGatewayClient
from local_rag_adapters import LocalEmbedding, LocalReranker, LocalAnswerGenerator

@contextmanager
def controlled_models(admin_dsn, tenant, principals):
    root = Path(__file__).resolve().parents[2]/"model-gateway"
    redis_name = "gg-rag-gateway-fixture-"+secrets.token_hex(5)
    provider = None
    process = None
    try:
        with TemporaryDirectory() as directory:
            path = Path(directory)
            embedding, reranker, answerer = LocalEmbedding(), LocalReranker(), LocalAnswerGenerator()
            class Provider(BaseHTTPRequestHandler):
                def log_message(self, *_args): pass
                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    if self.path == '/v1/embeddings':
                        vectors = embedding.embed(body['input'], tenant_id=tenant, model=embedding.model, input_type='query')
                        result = {'data':[{'index':i,'embedding':v} for i,v in enumerate(vectors)], 'usage':{'total_tokens':1}}
                    else:
                        data = json.loads(body['messages'][1]['content'])
                        if body['model']==reranker.model:
                            indexes = reranker.rerank(data['query'], data['documents'], tenant_id=tenant, model=reranker.model, top_n=data['top_n'])
                            content = {'results':[{'index':i,'score':1.0} for i in indexes]}
                        else:
                            content = answerer.answer(data['question'], data['context'], tenant_id=tenant, model=answerer.model)
                        result = {'choices':[{'message':{'content':json.dumps(content)}}], 'usage':{'prompt_tokens':1,'completion_tokens':1}}
                    output = json.dumps(result).encode()
                    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(output)));self.end_headers();self.wfile.write(output)
            provider = ThreadingHTTPServer(('127.0.0.1',0),Provider)
            thread=Thread(target=provider.serve_forever,daemon=True);thread.start()
            password=secrets.token_hex(24)
            with psycopg.connect(admin_dsn) as db:
                db.execute(sql.SQL("CREATE ROLE model_gateway_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD {}").format(sql.Literal(password)))
                db.execute((root/'migrations/001_budget.sql').read_text())
                db.execute("INSERT INTO ai_platform_budget(period,limit_micros,limit_tokens) VALUES(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,300000000,100000000)")
                for scope in ['tenant']+['user:'+p for p in principals]:
                    db.execute("INSERT INTO ai_budget_accounts(tenant_id,scope,period,limit_micros,limit_tokens) VALUES(%s,%s,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,10000000,10000000)",(tenant,scope))
            subprocess.run(['docker','run','-d','--name',redis_name,'-p','127.0.0.1::6379','redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499','redis-server','--save','','--appendonly','no'],check=True,stdout=subprocess.DEVNULL)
            info=json.loads(subprocess.check_output(['docker','inspect',redis_name]))[0]
            redis_port=info['NetworkSettings']['Ports']['6379/tcp'][0]['HostPort']
            token=secrets.token_hex(24)
            access={'token_hashes':{sha256(token.encode()).hexdigest():{'tenant_id':tenant,'trusted_user_context':True,'scopes':['knowledge:embed','knowledge:rerank','knowledge:answer']}},'embedding_models':{embedding.model:embedding.model},'reranker_models':{reranker.model:reranker.model},'answer_models':{answerer.model:answerer.model}}
            controls=json.loads((root/'controls.example.json').read_text());controls['admission']['provider']={'legacy':{'capacity':200,'refill_per_second':100,'concurrent':20}}
            controls['prices']={m:{'input_micros_per_million':1000000,'output_micros_per_million':5000000} for m in [embedding.model,reranker.model,answerer.model]}
            def secret(name,value):
                file=path/name;file.write_text(value);file.chmod(0o600);return str(file)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1',0));gateway_port=reservation.getsockname()[1]
            env=dict(os.environ,MODEL_GATEWAY_ACCESS_FILE=secret('access',json.dumps(access)),MODEL_GATEWAY_CONTROLS_FILE=secret('controls',json.dumps(controls)),MODEL_GATEWAY_REDIS_URL_FILE=secret('redis',f'redis://127.0.0.1:{redis_port}'),MODEL_GATEWAY_BUDGET_DSN_FILE=secret('budget',make_conninfo(admin_dsn,user='model_gateway_app',password=password)),MODEL_GATEWAY_PROVIDER_URL=f'http://127.0.0.1:{provider.server_port}/v1',MODEL_GATEWAY_PROVIDER_KEY='synthetic-provider-key',MODEL_GATEWAY_LISTEN_ADDR=f'127.0.0.1:{gateway_port}')
            subprocess.run(['go','build','-o',str(path/'gateway'),'./cmd/model-gateway'],cwd=root,check=True)
            process=subprocess.Popen([str(path/'gateway')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            for _ in range(100):
                if process.poll() is not None:raise AssertionError('controlled gateway exited before readiness')
                try:
                    with urlopen(f'http://127.0.0.1:{gateway_port}/healthz',timeout=1):break
                except OSError:time.sleep(.05)
            else:raise AssertionError('gateway readiness timeout')
            client=ModelGatewayClient(base_url=f'http://127.0.0.1:{gateway_port}',task_token=token)
            client.embedding_model=embedding.model;client.reranker_model=reranker.model;client.answer_model=answerer.model
            yield client
            with psycopg.connect(admin_dsn) as db:
                rows=db.execute("SELECT principal_id,provider,state,usage_known FROM ai_budget_attempts WHERE tenant_id=%s",(tenant,)).fetchall()
                assert len(rows)>=4 and any(r[0]==principals[0] for r in rows)
                assert all(r[2]=='settled' and r[3] for r in rows)
                assert db.execute("SELECT count(*) FROM ai_usage_outbox WHERE tenant_id=%s",(tenant,)).fetchone()[0]==len(rows)
            print('CONTROLLED_GATEWAY_RAG_PASS: authenticated HTTP PDF/index/query → real Go gateway → real Redis/Postgres limits + verified user accounting → synthetic providers → cited answer')
    finally:
        if process:
            process.terminate()
            try:process.wait(timeout=8)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        if provider:provider.shutdown();provider.server_close();thread.join(timeout=2)
        subprocess.run(['docker','rm','-f',redis_name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
