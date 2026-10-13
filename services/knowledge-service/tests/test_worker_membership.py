from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import MagicMock
from knowledge_extensions.oidc_auth import PostgresMemberships
from knowledge_extensions.http_api import ApiError
T='11111111-1111-4111-8111-111111111111'
U='22222222-2222-4222-8222-222222222222'

class WorkerMembershipTests(TestCase):
    def membership(self,row):
        connection=MagicMock();connection.transaction.side_effect=lambda:nullcontext()
        connection.__enter__.return_value=connection
        connection.execute.return_value.fetchone.return_value=row
        return PostgresMemberships(lambda:connection),connection
    def test_worker_resolves_canonical_owner_even_with_external_delegated_alias(self):
        memberships,c=self.membership((['operator'],))
        principal=memberships.resolve_principal(tenant_id=T,principal_id=U)
        self.assertEqual((principal.principal_id,principal.role),(U,'operator'))
        sql,args=c.execute.call_args.args
        self.assertIn('tenant_id=%s AND principal_id=%s AND active=true',sql)
        self.assertNotIn('delegated_identity_id',sql);self.assertEqual(args,(T,U))
    def test_revoked_or_foreign_owner_denies(self):
        memberships,_=self.membership(None)
        with self.assertRaises(ApiError) as error:
            memberships.resolve_principal(tenant_id=T,principal_id=U)
        self.assertEqual(error.exception.status,403)
