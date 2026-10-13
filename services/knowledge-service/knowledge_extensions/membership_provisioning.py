"""Separate trusted control-plane membership mutation with atomic audit.

Never expose this operation under the knowledge_app database role.
Expected revision 0 creates; every update compares the current revision.
"""
from uuid import uuid4
from .oidc_auth import canonical_uuid, configured_oidc_url

class MembershipConflict(ValueError):pass

def provision(connection,*,tenant_id,issuer,subject,principal_id,roles,active,expected_revision,actor_id,reason,allow_local_http=False):
 if not all(canonical_uuid(value) for value in (tenant_id,principal_id,actor_id)):
  raise ValueError('invalid provisioning identity')
 if not configured_oidc_url(issuer,allow_local_http=allow_local_http):
  raise ValueError('invalid issuer')
 if not isinstance(subject,str) or not 1<=len(subject)<=512 or not isinstance(reason,str) or not 1<=len(reason)<=256:
  raise ValueError('invalid provisioning metadata')
 if type(active) is not bool or type(expected_revision) is not int or expected_revision<0 or not isinstance(roles,list) or not 1<=len(roles)<=3 or any(r not in {'viewer','operator','admin'} for r in roles) or len(set(roles))!=len(roles):
  raise ValueError('invalid provisioning state')
 with connection.transaction():
  connection.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant_id,))
  if expected_revision==0:
   row=connection.execute("""INSERT INTO knowledge_auth_memberships(tenant_id,issuer,subject,principal_id,roles,active)
    VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING revision""",(tenant_id,issuer,subject,principal_id,roles,active)).fetchone()
  else:
   row=connection.execute("""UPDATE knowledge_auth_memberships SET roles=%s,active=%s,revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=%s AND issuer=%s AND subject=%s AND principal_id=%s AND revision=%s RETURNING revision""",(roles,active,tenant_id,issuer,subject,principal_id,expected_revision)).fetchone()
  if row is None:raise MembershipConflict('membership revision conflict')
  revision=row[0]
  connection.execute("""INSERT INTO knowledge_membership_audit(tenant_id,event_id,actor_id,issuer,subject,revision,active,roles,reason)
    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",(tenant_id,str(uuid4()),actor_id,issuer,subject,revision,active,roles,reason))
  return revision
