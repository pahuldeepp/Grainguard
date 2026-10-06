import unittest
from unittest.mock import patch, MagicMock
from advisor_security.membership import ControlPlaneMemberships
from advisor_security.alerts import AlertsOwnership
from advisor_security.execution import AlertsExecutor
from advisor_security.receiver import configured_server


class MeshOwnerTests(unittest.TestCase):
    def test_each_exact_owner_requires_explicit_mesh_opt_in(self):
        cases = (
            (ControlPlaneMemberships, 'tenant-control-plane', 3010, ('a' * 32,)),
            (AlertsOwnership, 'workflow-alerts', 3004, ('a' * 32,)),
            (AlertsExecutor, 'workflow-alerts', 3004, ()),
        )
        for constructor, service, port, args in cases:
            url = f'http://{service}.greenguard.svc.cluster.local:{port}'
            with self.subTest(service=service, constructor=constructor):
                with self.assertRaises(ValueError): constructor(url, *args)
                constructor(url, *args, allow_mesh_http=True)
                for other in (url.replace('.greenguard.', '.foreign.'), url + '/other',
                              url + '?selector=1', url.replace(f':{port}', ':9999'),
                              url.replace('http://', 'http://user@'), 'http://external.example'):
                    with self.assertRaises(ValueError): constructor(other, *args, allow_mesh_http=True)
                with self.assertRaises(ValueError): constructor(url, *args, allow_mesh_http='true')

    def test_readiness_reaches_database_membership_and_alerts_owner(self):
        with patch('advisor_security.receiver.psycopg.connect') as connect, \
             patch('advisor_security.receiver.ControlPlaneMemberships') as memberships, \
             patch('advisor_security.receiver.bounded_get', return_value=(200, b'')) as owner, \
             patch('advisor_security.receiver.create_server', return_value=MagicMock()) as create:
            configured_server(issuer='https://bff.example', jwks_url='https://bff.example/jwks',
                membership_url='https://control.example', membership_service_token='a' * 32,
                database_url='postgresql://advisor/db', alerts_origin='https://alerts.example',
                alerts_service_token='a' * 32, key_resolver=lambda _: None)
            self.assertTrue(create.call_args.kwargs['healthcheck']())
            connect.return_value.__enter__.return_value.execute.assert_called_once_with('SELECT 1')
            memberships.return_value.assert_called_once_with(
                '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001')
            owner.assert_called_once_with('https://alerts.example/readyz', None,
                                          operation='Advisor.owner.readiness')
