"""Trusted local control-plane CLI; never use knowledge_app credentials."""
import argparse,json,os
from pathlib import Path
from urllib.parse import urlsplit
import psycopg
from knowledge_extensions.membership_provisioning import provision

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--request-file',required=True);args=parser.parse_args()
 dsn=os.environ.get('KNOWLEDGE_PROVISIONING_DATABASE_URL','')
 if not dsn:parser.error('KNOWLEDGE_PROVISIONING_DATABASE_URL required')
 if os.environ.get('KNOWLEDGE_ENVIRONMENT')!='local-synthetic' or urlsplit(dsn).hostname not in {'localhost','127.0.0.1','::1'}:parser.error('CLI currently restricted to local-synthetic loopback database')
 path=Path(args.request_file)
 if path.stat().st_size>8192:parser.error('request exceeds bound')
 body=json.loads(path.read_text())
 if not isinstance(body,dict):parser.error('request must be an object')
 with psycopg.connect(dsn,connect_timeout=5) as connection:
  role=connection.execute('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user').fetchone()
  if role!=('knowledge_provisioner',False,False):parser.error('dedicated NOBYPASSRLS knowledge_provisioner role required')
  revision=provision(connection,**body,allow_local_http=os.environ.get("AUTH_ALLOW_LOCAL_HTTP")=="true")
 print(json.dumps({'revision':revision}))
if __name__=='__main__':main()
