import json,time,unittest,threading
from unittest.mock import patch
from unittest.mock import Mock
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
from knowledge_extensions.oidc_auth import CompositeOidcAuthenticator, OidcAuthenticator
from knowledge_extensions.http_api import ApiError,ApiPrincipal

class AuthTests(unittest.TestCase):
 def setUp(self):
  self.key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
  self.member=Mock();self.member.resolve.return_value=ApiPrincipal('11111111-1111-4111-8111-111111111111','88888888-8888-4888-8888-888888888888','viewer')
  self.auth=OidcAuthenticator(issuer='https://issuer.example',audience='knowledge',jwks_url='https://issuer.example/keys',memberships=self.member)
  self.auth._opener=Mock();response=Mock();response.read.return_value=json.dumps({'keys':[json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))|{'kid':'k1'}]}).encode();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);self.auth._opener.open.return_value=response
 def token(self,**claims):
  now=int(time.time());return jwt.encode({'iss':self.auth.issuer,'aud':'knowledge','sub':'subject','iat':now,'exp':now+300}|claims,self.key,algorithm='RS256',headers={'kid':'k1'})
 def cognito_auth(self):
  auth=OidcAuthenticator(issuer='https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example',audience='',jwks_url='https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json',memberships=self.member,token_mode='cognito-access',client_ids=['webclient123','mobileclient456'])
  auth._opener=self.auth._opener
  return auth
 def cognito_token(self,auth,**claims):
  now=int(time.time())
  return jwt.encode({'iss':auth.issuer,'sub':'cognito-subject','iat':now,'exp':now+300,'token_use':'access','client_id':'webclient123','username':'user@example.test','auth_time':now}|claims,self.key,algorithm='RS256',headers={'kid':'k1'})
 def denied(self,token,status=401):
  with self.assertRaises(ApiError) as e:self.auth('Bearer '+token,'11111111-1111-4111-8111-111111111111')
  self.assertEqual(e.exception.status,status)
 def test_delegated_kind_is_separate_and_read_only(self):
  tenant='11111111-1111-4111-8111-111111111111';subject='88888888-8888-4888-8888-888888888888'
  token=self.token(sub=subject,token_use='delegated',nbf=int(time.time()),jti='test-jti',tenant_id=tenant,roles=['viewer'],act={'sub':'grain-advisor'},scope='knowledge:read')
  self.denied(token)
  self.auth.delegated_mode=True
  self.denied(self.token())
  self.member.resolve_delegated.return_value=ApiPrincipal(tenant,subject,'viewer')
  result=self.auth('Bearer '+token,tenant)
  self.assertTrue(result.read_only)
  self.assertEqual(result.principal_id,subject)

 def test_claim_roles_are_ignored(self):
  result=self.auth('Bearer '+self.token(role='admin',tenant_id='forged'),'11111111-1111-4111-8111-111111111111')
  self.assertEqual(result.role,'viewer');self.member.resolve.assert_called_once_with(issuer=self.auth.issuer,subject='subject',tenant_id=result.tenant_id)
 def test_cognito_access_mode_requires_exact_access_token_contract(self):
  auth=self.cognito_auth();token=self.cognito_token(auth)
  principal=auth('Bearer '+token,'11111111-1111-4111-8111-111111111111')
  self.assertEqual(principal.role,'viewer')
  self.member.resolve.assert_called_once_with(issuer=auth.issuer,subject='cognito-subject',tenant_id=principal.tenant_id)
  for claims in (
   {'token_use':'id'}, {'client_id':'unapproved'}, {'username':''}, {'auth_time':'now'},
   {'sub':'webclient123'}, {'grant_type':'client_credentials'}, {'aud':'unexpected'},
  ):
   with self.subTest(claims=claims):
    with self.assertRaises(ApiError) as error:auth('Bearer '+self.cognito_token(auth,**claims),'11111111-1111-4111-8111-111111111111')
    self.assertEqual(error.exception.status,401)
  with self.assertRaises(ValueError):
   OidcAuthenticator(issuer=auth.issuer,audience='',jwks_url=auth.jwks_url,memberships=self.member,token_mode='cognito-access',client_ids=[])
 def test_bad_claims(self):
  for claims in [{'aud':'other'},{'iss':'https://other.example'},{'exp':int(time.time())-10},{'iat':int(time.time())+60},{'exp':int(time.time())+7200},{'token_use':'id'},{'sub':''}]:
   with self.subTest(claims=claims):self.denied(self.token(**claims))
 def test_algorithm_and_key_url_rejected_before_fetch(self):
  self.denied(jwt.encode({'sub':'x'},'long-enough-secret-for-test-only-123',algorithm='HS256',headers={'kid':'k1'}))
  self.denied(jwt.encode({'sub':'x'},self.key,algorithm='RS256',headers={'kid':'k1','jku':'https://attacker.example'}))
  self.auth._opener.open.assert_not_called()
 def test_jwks_cache_and_unknown_kid_cooldown(self):
  self.auth('Bearer '+self.token(),'11111111-1111-4111-8111-111111111111');self.auth('Bearer '+self.token(),'11111111-1111-4111-8111-111111111111')
  self.denied(jwt.encode({'sub':'x'},self.key,algorithm='RS256',headers={'kid':'unknown'}))
  self.assertEqual(self.auth._opener.open.call_count,1)
 def test_jwks_outage_fails_closed(self):
  self.auth._opener.open.side_effect=OSError('offline');self.denied(self.token(),503)
 def test_private_jwk_rejected(self):
  self.auth._opener.open.return_value.read.return_value=json.dumps({'keys':[json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key))|{'kid':'k1'}]}).encode();self.denied(self.token(),503)

 def test_cached_key_does_not_wait_for_network_refresh(self):
  tenant='11111111-1111-4111-8111-111111111111'
  self.auth('Bearer '+self.token(),tenant)
  started=threading.Event();release=threading.Event()
  response=self.auth._opener.open.return_value
  def blocking(*args,**kwargs):
   started.set();release.wait(2);return response
  self.auth._opener.open.side_effect=blocking;self.auth._next_refresh=0
  def refresh():
   try:self.auth._key('unknown')
   except ApiError:pass
  worker=threading.Thread(target=refresh);worker.start();self.assertTrue(started.wait(1))
  try:
   result=self.auth('Bearer '+self.token(),tenant);self.assertEqual(result.role,'viewer')
  finally:release.set();worker.join(timeout=2)

 def test_local_http_requires_explicit_flag_and_synthetic_environment(self):
  url='http://127.0.0.1:5556/dex'
  def create(**options):
   return OidcAuthenticator(issuer=url,audience='greenguard-dashboard',jwks_url=url+'/keys',memberships=self.member,**options)
  with patch.dict('os.environ',{'KNOWLEDGE_ENVIRONMENT':'local-synthetic'}):
   with self.assertRaises(ValueError):create()
   create(allow_local_http=True)
  with patch.dict('os.environ',{'KNOWLEDGE_ENVIRONMENT':'production'}):
   with self.assertRaises(ValueError):create(allow_local_http=True)

 def test_local_http_never_accepts_remote_or_ambiguous_endpoints(self):
  with patch.dict('os.environ',{'KNOWLEDGE_ENVIRONMENT':'local-synthetic'}):
   for url in ('http://dex:5556/dex','http://127.0.0.1.attacker.test/dex',
               'http://user@127.0.0.1/dex','http://127.0.0.1/dex?redirect=x','http://127.0.0.1/dex#fragment'):
    with self.subTest(url=url),self.assertRaises(ValueError):
     OidcAuthenticator(issuer=url,audience='knowledge',jwks_url=url+'/keys',memberships=self.member,allow_local_http=True)

 def test_composite_selects_hint_but_selected_verifier_remains_authoritative(self):
  primary=Mock();delegated=Mock();delegated.issuer='https://delegate.example'
  principal=ApiPrincipal('11111111-1111-4111-8111-111111111111','88888888-8888-4888-8888-888888888888','viewer')
  primary.side_effect=ApiError(503,'auth_unavailable');delegated.return_value=principal
  token=jwt.encode({'iss':delegated.issuer},self.key,algorithm='RS256')
  composite=CompositeOidcAuthenticator(primary,delegated)
  self.assertIs(composite('Bearer '+token,'tenant'),principal)
  primary.assert_not_called()
  delegated.assert_called_once_with('Bearer '+token,'tenant')
  with self.assertRaises(ApiError) as error:composite('Bearer malformed','tenant')
  self.assertEqual(error.exception.status,503)
  self.assertEqual(delegated.call_count,1)
  delegated.side_effect=ApiError(401,'invalid_token')
  with self.assertRaises(ApiError) as error:composite('Bearer '+token,'tenant')
  self.assertEqual(error.exception.status,401)

class DelegatedMembershipAliasTests(unittest.TestCase):
 def lookup(self,row):
  from knowledge_extensions.oidc_auth import PostgresMemberships
  connection=Mock();connection.__enter__=Mock(return_value=connection);connection.__exit__=Mock(return_value=False)
  transaction=Mock();transaction.__enter__=Mock();transaction.__exit__=Mock(return_value=False);connection.transaction.return_value=transaction
  connection.execute.return_value.fetchone.return_value=row
  return PostgresMemberships(lambda:connection),connection
 def test_alias_preserves_existing_acl_principal_and_current_role(self):
  original='22222222-2222-4222-8222-222222222222';alias='33333333-3333-4333-8333-333333333333';tenant='11111111-1111-4111-8111-111111111111'
  memberships,c=self.lookup((original,['viewer']))
  result=memberships.resolve_delegated(subject=alias,tenant_id=tenant)
  self.assertEqual(result,ApiPrincipal(tenant,original,'viewer'))
  sql,params=c.execute.call_args.args
  self.assertIn('COALESCE(delegated_identity_id,principal_id)',sql);self.assertIn('active=true',sql);self.assertEqual(params,(tenant,alias))
 def test_revoked_or_foreign_alias_denied(self):
  memberships,_=self.lookup(None)
  with self.assertRaises(ApiError) as caught:memberships.resolve_delegated(subject='33333333-3333-4333-8333-333333333333',tenant_id='11111111-1111-4111-8111-111111111111')
  self.assertEqual(caught.exception.status,403)


class ControlPlaneMembershipTests(unittest.TestCase):
 TENANT='11111111-1111-4111-8111-111111111111'
 OTHER='22222222-2222-4222-8222-222222222222'
 SUBJECT='alice@example.test'
 TOKEN='x'*40

 def client(self, body=None, *, status=200, error=None):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  response=Mock();response.status=status;response.read.return_value=json.dumps(body).encode()
  response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
  opener=Mock()
  if error is not None:opener.open.side_effect=error
  else:opener.open.return_value=response
  return ControlPlaneMemberships(base_url='https://control.example',token=self.TOKEN,opener=opener),opener

 def active(self, tenant=None, roles=None):
  return {'tenantId':tenant or self.TENANT,'roles':['operator'] if roles is None else roles,'version':'7','state':'active'}

 def test_active_owner_is_authoritative_and_uses_stable_control_plane_identity(self):
  from knowledge_extensions.oidc_auth import identity_id_of
  client,opener=self.client(self.active())
  principal=client.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  self.assertEqual(principal,ApiPrincipal(self.TENANT,identity_id_of('https://issuer.example',self.SUBJECT),'operator'))
  request=opener.open.call_args.args[0]
  self.assertIn('/v1/internal/memberships?',request.full_url)
  self.assertEqual(request.get_header('Authorization'),'Bearer '+self.TOKEN)
  self.assertLessEqual(opener.open.call_args.kwargs['timeout'],2)
  self.assertFalse(client.uses_database_membership)

 def test_revoked_missing_foreign_and_outage_fail_closed(self):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  cases=[(None,403),( {'tenantId':self.TENANT,'roles':[],'version':'8','state':'revoked'},403),
          (self.active(self.OTHER),403)]
  for body,status in cases:
   with self.subTest(body=body):
    client,_=self.client(body,status=404 if body is None else 200)
    with self.assertRaises(ApiError) as error:client.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
    self.assertEqual(error.exception.status,status)
  client,_=self.client(error=OSError('private transport detail'))
  with self.assertRaises(ApiError) as error:client.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  self.assertEqual((error.exception.status,str(error.exception)),(503,'auth_unavailable'))

 def test_malformed_or_stale_role_payload_fails_closed(self):
  for body in (self.active(roles=['owner']),self.active(roles=[]),self.active(roles=['viewer','viewer']),
               self.active()|{'version':'0'},self.active()|{'version':'8','state':'revoked'}):
   with self.subTest(body=body):
    client,_=self.client(body)
    with self.assertRaises(ApiError) as error:client.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
    self.assertEqual(error.exception.status,503)

 def test_owner_version_regression_and_same_version_role_replay_fail_closed(self):
  latest,_=self.client(self.active(roles=['admin'])|{'version':'8'})
  latest.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  for stale in (self.active(roles=['viewer'])|{'version':'7'}, self.active(roles=['viewer'])|{'version':'8'}):
   client,_=self.client(stale)
   client._membership_versions=latest._membership_versions
   client._membership_versions_lock=latest._membership_versions_lock
   with self.assertRaises(ApiError) as error:client.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
   self.assertEqual((error.exception.status,str(error.exception)),(503,'auth_unavailable'))

 def test_missing_membership_fences_replayed_old_active_version(self):
  active,_=self.client(self.active()|{'version':'12'})
  active.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  missing,_=self.client(status=404)
  missing._membership_versions=active._membership_versions
  missing._membership_versions_lock=active._membership_versions_lock
  with self.assertRaises(ApiError) as error:missing.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  self.assertEqual(error.exception.status,403)
  replay,_=self.client(self.active()|{'version':'12'})
  replay._membership_versions=active._membership_versions
  replay._membership_versions_lock=active._membership_versions_lock
  with self.assertRaises(ApiError) as error:replay.resolve(issuer='https://issuer.example',subject=self.SUBJECT,tenant_id=self.TENANT)
  self.assertEqual((error.exception.status,str(error.exception)),(503,'auth_unavailable'))

 def test_delegated_owner_lookup_binds_subject_and_tenant(self):
  body={'tenantId':self.TENANT,'identityId':self.TENANT,'roles':['viewer'],'version':'3','state':'active'}
  client,opener=self.client(body)
  principal=client.resolve_delegated(subject=self.TENANT,tenant_id=self.TENANT)
  self.assertEqual(principal,ApiPrincipal(self.TENANT,self.TENANT,'viewer'))
  self.assertIn('/v1/internal/delegated-memberships?',opener.open.call_args.args[0].full_url)
  wrong,_=self.client(body|{'identityId':self.OTHER})
  with self.assertRaises(ApiError) as error:wrong.resolve_delegated(subject=self.TENANT,tenant_id=self.TENANT)
  self.assertEqual(error.exception.status,403)

 def test_owner_url_requires_https_or_the_exact_opted_in_mesh_endpoint(self):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  for url,allowed in [('http://control.example',False),
                      ('http://tenant-control-plane.greenguard.svc.cluster.local:3010',True),
                      ('http://tenant-control-plane.greenguard.svc.cluster.local:3011',False),
                      ('https://control.example',True)]:
   with self.subTest(url=url,allowed=allowed):
    if allowed:
     ControlPlaneMemberships(base_url=url,token=self.TOKEN,allow_mesh_http=True)
    else:
      with self.assertRaises(ValueError):ControlPlaneMemberships(base_url=url,token=self.TOKEN,allow_mesh_http=False)

 def test_readiness_uses_only_reserved_subject_and_accepts_owner_404(self):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  from urllib.error import HTTPError
  response=Mock();response.status=404
  opener=Mock();opener.open.side_effect=HTTPError('https://control.example/lookup',404,'not found',{},None)
  client=ControlPlaneMemberships(base_url='https://control.example',token=self.TOKEN,opener=opener)
  client.check_readiness(issuer='https://issuer.example')
  request=opener.open.call_args.args[0]
  self.assertIn('greenguard-readiness-check-v1',request.full_url)
  self.assertNotIn(self.SUBJECT,request.full_url)
  self.assertEqual(request.get_header('Authorization'),'Bearer '+self.TOKEN)
  self.assertLessEqual(opener.open.call_args.kwargs['timeout'],2)

 def test_readiness_owner_authorization_failure_is_not_ready(self):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  from urllib.error import HTTPError
  opener=Mock();opener.open.side_effect=HTTPError('https://control.example/lookup',403,'forbidden',{},None)
  client=ControlPlaneMemberships(base_url='https://control.example',token=self.TOKEN,opener=opener)
  with self.assertRaises(ApiError) as error:client.check_readiness(issuer='https://issuer.example')
  self.assertEqual((error.exception.status,str(error.exception)),(503,'auth_unavailable'))

 def test_runtime_defaults_to_control_plane_and_allows_postgres_only_in_local_synthetic_mode(self):
  import os
  from serve import _membership_authority
  with patch.dict(os.environ, {'CONTROL_PLANE_URL':'https://control.example','CONTROL_LOOKUP_TOKEN':self.TOKEN}, clear=True):
   self.assertFalse(_membership_authority(lambda:None).uses_database_membership)
  with patch.dict(os.environ, {'KNOWLEDGE_MEMBERSHIP_SOURCE':'postgres','KNOWLEDGE_ENVIRONMENT':'production'}, clear=True):
   with self.assertRaises(SystemExit):_membership_authority(lambda:None)
  with patch.dict(os.environ, {'KNOWLEDGE_MEMBERSHIP_SOURCE':'postgres','KNOWLEDGE_ENVIRONMENT':'local-synthetic'}, clear=True):
   self.assertTrue(_membership_authority(lambda:None).uses_database_membership)

 def test_inflight_request_reauthorization_observes_role_change_and_revocation(self):
  from knowledge_extensions.oidc_auth import ControlPlaneMemberships
  states=[self.active(roles=['admin'])|{'version':'7'},self.active(roles=['viewer'])|{'version':'8'},
          {'tenantId':self.TENANT,'roles':[],'version':'9','state':'revoked'}]
  response=Mock();response.status=200
  response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
  opener=Mock()
  def lookup(*_args,**_kwargs):
   response.read.return_value=json.dumps(states.pop(0)).encode()
   return response
  opener.open.side_effect=lookup
  memberships=ControlPlaneMemberships(base_url='https://control.example',token=self.TOKEN,opener=opener)
  key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
  auth=OidcAuthenticator(issuer='https://issuer.example',audience='knowledge',jwks_url='https://issuer.example/keys',memberships=memberships)
  jwks=Mock();jwks.read.return_value=json.dumps({'keys':[json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))|{'kid':'k1'}]}).encode()
  jwks.__enter__=Mock(return_value=jwks);jwks.__exit__=Mock(return_value=False);auth._opener=Mock();auth._opener.open.return_value=jwks
  now=int(time.time());token='Bearer '+jwt.encode({'iss':auth.issuer,'aud':'knowledge','sub':self.SUBJECT,'iat':now,'exp':now+300},key,algorithm='RS256',headers={'kid':'k1'})
  initial=auth(token,self.TENANT)
  # The same operation's final authorization call sees a downgrade immediately.
  refreshed=auth(token,self.TENANT)
  self.assertNotEqual(initial.role,refreshed.role)
  self.assertEqual(refreshed.role,'viewer')
  # A later revocation makes the final admission check fail closed.
  with self.assertRaises(ApiError) as error:auth(token,self.TENANT)
  self.assertEqual((error.exception.status,str(error.exception)),(403,'membership_required'))
