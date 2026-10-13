import unittest
import time
from uuid import uuid4
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from advisor_security.delegated import DelegatedVerifier,DelegationError

class DelegatedTests(unittest.TestCase):
    def setUp(self):
        self.key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        now=int(time.time());self.tenant=str(uuid4());self.user=str(uuid4());self.current=['operator']
        self.claims={'iss':'https://delegation.test','aud':'grain-advisor','sub':self.user,'tenant_id':self.tenant,'roles':['operator'],'act':{'sub':'grain-advisor'},'scope':'advisor:decide','token_use':'delegated','iat':now,'nbf':now,'exp':now+120,'jti':str(uuid4())}
        self.verifier=DelegatedVerifier(issuer='https://delegation.test',audience='grain-advisor',scope='advisor:decide',key_resolver=lambda kid:self.key.public_key() if kid=='key1' else None,membership=lambda tenant,user:self.current if (tenant,user)==(self.tenant,self.user) else None)
    def token(self,changes=None,headers=None,key=None):return 'Bearer '+jwt.encode({**self.claims,**(changes or {})},key or self.key,algorithm='RS256',headers=headers or {'typ':'at+jwt','kid':'key1'})
    def test_verified_identity_and_revocation(self):
        principal=self.verifier.verify(self.token(),self.tenant);self.assertEqual(principal.user_id,self.user)
        for current in [None,[],['viewer']]:
            self.current=current
            with self.assertRaises(DelegationError):self.verifier.verify(self.token())
        self.current=['operator']
        with self.assertRaises(DelegationError):self.verifier.verify(self.token(),str(uuid4()))
    def test_forged_wrong_scope_audience_and_expiry(self):
        for changes in [{'aud':['grain-advisor','workflow-alerts']},{'scope':'advisor:propose'},{'act':{'sub':'attacker'}},{'roles':['device']},{'token_use':'access'},{'exp':self.claims['iat']+301},{'exp':1},{'sub':'untrusted'},{'tenant_id':str(uuid4())},{'iat':True}]:
            with self.subTest(changes=changes):
                with self.assertRaises(DelegationError):self.verifier.verify(self.token(changes))
        with self.assertRaises(DelegationError):self.verifier.verify(self.token(headers={'typ':'at+jwt','kid':'key1','jku':'https://attacker.invalid'}))
        other=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        with self.assertRaises(DelegationError):self.verifier.verify(self.token(key=other))
    def test_outages_fail_closed(self):
        def fail(*args):raise RuntimeError('not exposed')
        self.verifier.membership=fail
        with self.assertRaises(DelegationError) as caught:self.verifier.verify(self.token())
        self.assertEqual(caught.exception.status,503)
        self.verifier.key_resolver=fail
        with self.assertRaises(DelegationError) as caught:self.verifier.verify(self.token())
        self.assertEqual(caught.exception.status,503)
