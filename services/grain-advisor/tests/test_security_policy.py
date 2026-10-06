from datetime import datetime,timedelta,timezone
import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from advisor_security.policy import Principal,PolicyDenied,authorize_tool,TurnBudget,load_policy
from advisor_security.proposals import digest

class SecurityPolicyTests(unittest.TestCase):
    def principal(self,role='operator',audience='grain-advisor',expired=False):
        return Principal(str(uuid4()),str(uuid4()),role,audience,datetime.now(timezone.utc)+timedelta(minutes=-1 if expired else 5))
    def test_tools_fail_closed(self):
        p=self.principal();args={'alert_id':str(uuid4()),'note':'Review','etag':'"v1"'}
        self.assertEqual(authorize_tool(p,'propose_acknowledge_alert',args)['kind'],'propose')
        for name in ['execute_acknowledge','shell','fetch_url','create_work_order','recommend_aeration']:
            with self.assertRaises(PolicyDenied):authorize_tool(p,name,args)
        for extra in ['tenant_id','user_id','role','url','sql']:
            with self.assertRaises(PolicyDenied):authorize_tool(p,'propose_acknowledge_alert',{**args,extra:'injected'})
        for principal in [self.principal('viewer'),self.principal(audience='workflow-alerts'),self.principal(expired=True)]:
            with self.assertRaises(PolicyDenied):authorize_tool(principal,'propose_acknowledge_alert',args)
    def test_read_schema_and_audience(self):
        p=self.principal('viewer','knowledge-service')
        authorize_tool(p,'search_knowledge',{'query':'Wheat storage?','k':8})
        for k in [True,0,9,'5']:
            with self.assertRaises(PolicyDenied):authorize_tool(p,'search_knowledge',{'query':'Wheat storage?','k':k})
    def test_turn_budget_concurrency_and_deadline(self):
        p=self.principal();clock=[0];budget=TurnBudget(p,str(uuid4()),lambda:clock[0])
        def admit(_):
            try:budget.admit(p);return 1
            except PolicyDenied:return 0
        with ThreadPoolExecutor(max_workers=12) as pool:self.assertEqual(sum(pool.map(admit,range(30))),8)
        other=TurnBudget(p,str(uuid4()),lambda:clock[0]);clock[0]=60
        with self.assertRaises(PolicyDenied):other.admit(p)
        with self.assertRaises(PolicyDenied):TurnBudget(p,str(uuid4())).admit(self.principal())
    def test_migration_dsn_is_local_and_separate(self):
        from migrate_security import validate_dsn
        validate_dsn('postgresql://localhost/greenguard_advisor')
        for dsn in ['postgresql://remote.invalid/greenguard_advisor','postgresql://localhost/greenguard_knowledge','postgresql://localhost/greenguard_advisor?host=remote.invalid']:
            with self.assertRaises(ValueError):validate_dsn(dsn)

    def test_hash_binds_exact_action(self):
        a={'action':'acknowledge_alert','target':'a','params':{'note':'x'},'preconditions':{'etag':'v1'}}
        self.assertEqual(digest(a),digest(dict(reversed(list(a.items())))))
        for key in a:
            self.assertNotEqual(digest(a),digest({**a,key:'tampered'}))
        self.assertEqual(set(load_policy()['tools']),{'search_knowledge','propose_acknowledge_alert'})
