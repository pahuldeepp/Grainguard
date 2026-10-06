from contextlib import nullcontext
from hashlib import sha256
from threading import Thread
from unittest import TestCase
from unittest.mock import MagicMock, patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from knowledge_extensions.document_access import load_pdf_source, safe_pdf_name
from knowledge_extensions.document_summary import DocumentSummaryError
from knowledge_extensions.http_api import create_server, ApiPrincipal
from pdf_fixture import make_text_pdf

TENANT='11111111-1111-4111-8111-111111111111'
DOC='22222222-2222-4222-8222-222222222222'
USER='33333333-3333-4333-8333-333333333333'
OTHER='44444444-4444-4444-8444-444444444444'

class SourceTests(TestCase):
    def test_source_metadata_repeats_tenant_acl_membership_and_version_checks(self):
        db=MagicMock();db.transaction.return_value=nullcontext()
        db.execute.return_value.fetchone.return_value=(f'tenant/{TENANT}/documents/{DOC}/versions/1/objects/id/file.pdf','a'*64,'Manual.pdf')
        info=load_pdf_source(db,tenant_id=TENANT,principal_id=USER,principal_role='viewer',document_id=DOC,document_version=1,require_membership=True)
        sql,params=db.execute.call_args.args
        self.assertIn('d.tenant_id=%s AND d.document_id=%s',sql)
        self.assertIn('d.current_version=v.document_version',sql)
        self.assertIn('m.active',sql)
        self.assertIn('acl_principals',sql)
        self.assertEqual(params[:3],(TENANT,DOC,1));self.assertEqual(info['filename'],'Manual.pdf')

    def test_foreign_or_revoked_source_is_not_found(self):
        db=MagicMock();db.transaction.return_value=nullcontext();db.execute.return_value.fetchone.return_value=None
        with self.assertRaises(DocumentSummaryError) as exc:
            load_pdf_source(db,tenant_id=OTHER,principal_id=USER,principal_role='viewer',document_id=DOC,document_version=1,require_membership=True)
        self.assertEqual(exc.exception.status,404)
        self.assertEqual(db.execute.call_args.args[1][0],OTHER)

    def test_filename_rejects_paths_and_header_injection(self):
        for name in ['../Manual.pdf','C:\\Manual.pdf','bad\r\n.pdf','bad.html','x'*241+'.pdf']:
            with self.subTest(name=name),self.assertRaises(ValueError):safe_pdf_name(name)
        self.assertEqual(safe_pdf_name('Grain checks – équipe.pdf'),'Grain checks – équipe.pdf')

    def test_pdf_http_is_authenticated_hash_checked_and_reauthorized(self):
        pdf=make_text_pdf([['Source test page.']])
        service=MagicMock();service._object_store.get_pdf.return_value=pdf
        token='test-source-token';digest=sha256(token.encode()).hexdigest()
        server=create_server(service=service,access_bindings={digest:ApiPrincipal(TENANT,USER,'viewer')},host='127.0.0.1',port=0)
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        info={'key':'private-key-not-in-response','sha256':sha256(pdf).hexdigest(),'filename':'Grain manual.pdf'}
        path=f'http://127.0.0.1:{server.server_port}/v1/documents/{DOC}/versions/1/source'
        try:
            with patch('knowledge_extensions.document_access.load_pdf_source',return_value=info) as load:
                with urlopen(Request(path,headers={'Authorization':'Bearer '+token}),timeout=3) as response:
                    self.assertEqual(response.read(),pdf);self.assertEqual(response.headers['Content-Type'],'application/pdf')
                    self.assertIn('Grain%20manual.pdf',response.headers['Content-Disposition'])
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                self.assertEqual(load.call_count,2)
            with patch('knowledge_extensions.document_access.load_pdf_source',side_effect=[info,DocumentSummaryError('not_found',404)]):
                with self.assertRaises(HTTPError) as exc:urlopen(Request(path,headers={'Authorization':'Bearer '+token}),timeout=3)
                self.assertEqual(exc.exception.code,404);exc.exception.close()
            with self.assertRaises(HTTPError) as exc:urlopen(path,timeout=3)
            self.assertEqual(exc.exception.code,401);exc.exception.close()
        finally:server.shutdown();server.server_close();thread.join(timeout=2)

    def test_delegated_read_only_token_cannot_upload(self):
        service=MagicMock();token='read-only-test'
        server=create_server(service=service,access_bindings={sha256(token.encode()).hexdigest():ApiPrincipal(TENANT,USER,'admin',read_only=True)},host='127.0.0.1',port=0)
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            request=Request(f'http://127.0.0.1:{server.server_port}/v1/documents/{DOC}',data=b'%PDF-1.7',headers={'Authorization':'Bearer '+token,'Content-Type':'application/pdf','X-Document-Version':'1'})
            with self.assertRaises(HTTPError) as exc:urlopen(request,timeout=3)
            self.assertEqual(exc.exception.code,403);exc.exception.close();service.ingest_pdf.assert_not_called()
        finally:server.shutdown();server.server_close();thread.join(timeout=2)

class DocumentManagementTests(TestCase):
    def test_document_list_is_tenant_acl_filtered(self):
        from knowledge_extensions.document_access import list_documents
        db=MagicMock();db.transaction.return_value=nullcontext();db.execute.return_value.fetchall.return_value=[]
        self.assertEqual(list_documents(db,tenant_id=OTHER,principal_id=USER,principal_role='viewer'),[])
        sql,params=db.execute.call_args.args
        self.assertIn('d.tenant_id=%s',sql);self.assertIn('acl_principals',sql)
        self.assertIn('LIMIT 200',sql);self.assertEqual(params[0],OTHER)

    def test_foreign_document_delete_denied_without_write(self):
        from knowledge_extensions.document_access import delete_document
        db=MagicMock();db.transaction.return_value=nullcontext();db.execute.return_value.fetchone.return_value=None
        with self.assertRaises(DocumentSummaryError) as exc:
            delete_document(db,tenant_id=OTHER,principal_id=USER,principal_role='operator',document_id=DOC)
        self.assertEqual(exc.exception.status,404)
        sql,params=db.execute.call_args.args
        self.assertIn('FOR UPDATE',sql);self.assertEqual(params[:2],(OTHER,DOC))
        self.assertNotIn('UPDATE knowledge_documents',sql)

    def test_viewer_cannot_delete(self):
        from knowledge_extensions.document_access import delete_document
        db=MagicMock()
        with self.assertRaises(DocumentSummaryError) as exc:
            delete_document(db,tenant_id=TENANT,principal_id=USER,principal_role='viewer',document_id=DOC)
        self.assertEqual(exc.exception.status,403);db.execute.assert_not_called()
