"""Durable Advisor proposals, decisions, and owner-authorized execution."""
import hashlib
import json
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL
import re
from .policy import authorize_tool, load_policy, PolicyDenied, uuid
from .execution import ExecutionError


class Conflict(ValueError):
    pass


class NotFound(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def scope(db, principal):
    db.execute("SELECT set_config('lock_timeout','1000ms',true),set_config('statement_timeout','5000ms',true)")
    db.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true),set_config('app.role',%s,true)",
               (principal.tenant_id, principal.user_id, principal.role))


def audit(db, principal, kind, proposal_id=None, tool='propose_acknowledge_alert'):
    event = str(uuid4())
    db.execute('INSERT INTO advisor_security_audit(tenant_id,event_id,user_id,proposal_id,kind,tool) VALUES(%s,%s,%s,%s,%s,%s)',
               (principal.tenant_id, event, principal.user_id, proposal_id, kind, tool))
    db.execute('INSERT INTO advisor_security_outbox(tenant_id,event_id,payload) VALUES(%s,%s,%s::jsonb)',
               (principal.tenant_id, event, canonical({'event_id': event, 'tenant_id': principal.tenant_id,
                                                        'user_id': principal.user_id, 'proposal_id': proposal_id,
                                                        'kind': kind, 'tool': tool})))


def _proposal_result(row):
    return {'proposal_id': row[0], 'action_hash': row[1], 'status': row[2], 'version': row[3],
            'expires_at': row[4].isoformat(), 'action': row[5], 'execution_status': row[6],
            'execution_attempts': row[7], 'execution_receipt': row[8]}


def propose(db, principal, run_id, args):
    authorize_tool(principal, 'propose_acknowledge_alert', args)
    if not uuid(run_id):
        raise PolicyDenied('invalid_run')
    action = {'action': 'acknowledge_alert', 'target': args['alert_id'],
              'params': {'note': args['note']}, 'preconditions': {'etag': args['etag']}}
    action_hash = digest(action)
    proposal_id = str(uuid5(UUID(run_id), principal.tenant_id + ':' + principal.user_id + ':' + action_hash))
    with db.transaction():
        scope(db, principal)
        row = db.execute("""INSERT INTO action_proposals(tenant_id,proposal_id,run_id,user_id,action_hash,action,status,expires_at)
          VALUES(%s,%s,%s,%s,%s,%s::jsonb,'pending',clock_timestamp()+interval '15 minutes')
          ON CONFLICT DO NOTHING RETURNING proposal_id""",
                         (principal.tenant_id, proposal_id, run_id, principal.user_id, action_hash, canonical(action))).fetchone()
        if row:
            audit(db, principal, 'proposed', proposal_id)
        result = db.execute('''SELECT proposal_id::text,action_hash,status,version,expires_at,action,
                                      execution_status,execution_attempts,execution_receipt
                               FROM action_proposals WHERE tenant_id=%s AND proposal_id=%s AND user_id=%s''',
                            (principal.tenant_id, proposal_id, principal.user_id)).fetchone()
        if result is None:
            raise NotFound('proposal_not_found')
    return _proposal_result(result)


def list_pending(db, principal, limit=50):
    principal.require('grain-advisor', 'operator')
    if type(limit) is not int or not 1 <= limit <= 100:
        raise PolicyDenied('invalid_limit')
    with db.transaction():
        scope(db, principal)
        rows = db.execute('''SELECT proposal_id::text,action_hash,status,version,expires_at,action,
                                    execution_status,execution_attempts,execution_receipt
                             FROM action_proposals
                             WHERE tenant_id=%s AND (status='pending' OR (status='approved' AND execution_status<>'succeeded'))
                             ORDER BY created_at ASC LIMIT %s''',
                          (principal.tenant_id, limit)).fetchall()
    return [_proposal_result(row) for row in rows]


def _execute_if_needed(db, principal, proposal_id, execute_action, owner_token):
    """Claim one execution attempt, call the owner outside SQL, then persist receipt."""
    if not callable(execute_action):
        raise ExecutionError('owner_execution_unavailable', True)
    if not isinstance(owner_token,str) or not re.fullmatch(r'Bearer [^\s]{32,16384}',owner_token):
        raise ExecutionError('owner_token_required')
    with db.transaction():
        scope(db, principal)
        row = db.execute('''SELECT status,execution_status,execution_attempts,action,
                                   execution_idempotency_key::text,execution_receipt,
                                   execution_claimed_at<=clock_timestamp()-interval '30 seconds'
                            FROM action_proposals
                            WHERE tenant_id=%s AND proposal_id=%s FOR UPDATE''',
                         (principal.tenant_id, proposal_id)).fetchone()
        if row is None:
            raise NotFound('proposal_not_found')
        status, execution_status, attempts, action, key, receipt, claim_expired = row
        if status != 'approved':
            return {'execution_status': 'not_applicable', 'execution_receipt': None}
        if execution_status == 'succeeded':
            return {'execution_status': execution_status, 'execution_receipt': receipt}
        if execution_status == 'failed':
            return {'execution_status': execution_status, 'execution_receipt': receipt}
        if execution_status == 'running' and claim_expired is False:
            return {'execution_status': 'running', 'execution_receipt': receipt}
        if attempts >= 8:
            return {'execution_status': 'failed', 'execution_receipt': receipt}
        key = key or str(uuid5(NAMESPACE_URL, principal.tenant_id + ':' + proposal_id + ':execution'))
        claimed = db.execute('''UPDATE action_proposals
                      SET execution_status='running', execution_attempts=execution_attempts+1,
                          execution_idempotency_key=%s, execution_claimed_at=clock_timestamp(), execution_error=NULL
                      WHERE tenant_id=%s AND proposal_id=%s
                        AND (execution_status IN ('pending','retryable')
                          OR (execution_status='running' AND execution_claimed_at<=clock_timestamp()-interval '30 seconds'))
                      RETURNING 1''',
                   (key, principal.tenant_id, proposal_id)).fetchone()
        if claimed is None:
            return {'execution_status': execution_status, 'execution_receipt': receipt}
        audit(db, principal, 'execution_started', proposal_id)
    try:
        receipt = execute_action(principal, action, owner_token, key)
    except ExecutionError as exc:
        with db.transaction():
            scope(db, principal)
            next_status = 'retryable' if exc.retryable and attempts + 1 < 8 else 'failed'
            db.execute('''UPDATE action_proposals SET execution_status=%s,execution_claimed_at=NULL,execution_error=%s
                          WHERE tenant_id=%s AND proposal_id=%s AND execution_status='running' ''',
                       (next_status, exc.code[:128], principal.tenant_id, proposal_id))
            audit(db, principal, 'execution_failed', proposal_id)
        raise
    except Exception as exc:
        with db.transaction():
            scope(db, principal)
            db.execute('''UPDATE action_proposals SET execution_status=%s,execution_claimed_at=NULL,execution_error=%s
                          WHERE tenant_id=%s AND proposal_id=%s AND execution_status='running' ''',
                       ('retryable' if attempts + 1 < 8 else 'failed', str(exc)[:128], principal.tenant_id, proposal_id))
            audit(db, principal, 'execution_failed', proposal_id)
        raise ExecutionError('execution_failed', attempts + 1 < 8) from exc
    with db.transaction():
        scope(db, principal)
        db.execute('''UPDATE action_proposals
                      SET execution_status='succeeded',execution_receipt=%s::jsonb,executed_at=clock_timestamp(),execution_claimed_at=NULL,execution_error=NULL
                      WHERE tenant_id=%s AND proposal_id=%s AND execution_status='running' ''',
                   (canonical(receipt), principal.tenant_id, proposal_id))
        audit(db, principal, 'executed', proposal_id)
    return {'execution_status': 'succeeded', 'execution_receipt': receipt}


def execute_approved(db, principal, proposal_id, *, action_hash, version, execute_action, owner_token):
    """Retry an approved action only at its current proposal version/hash."""
    principal.require('grain-advisor', 'operator')
    if not uuid(proposal_id) or not isinstance(action_hash, str) or len(action_hash) != 64 or type(version) is not int or version < 2:
        raise PolicyDenied('invalid_execution')
    with db.transaction():
        scope(db, principal)
        row = db.execute('''SELECT status,version,action_hash FROM action_proposals
                            WHERE tenant_id=%s AND proposal_id=%s''',
                         (principal.tenant_id, proposal_id)).fetchone()
        if row is None:
            raise NotFound('proposal_not_found')
        if row[0] != 'approved' or row[1] != version or row[2] != action_hash:
            raise Conflict('proposal_version_conflict')
    return _execute_if_needed(db, principal, proposal_id, execute_action, owner_token)


def decide(db, principal, proposal_id, *, decision, action_hash, version, request_id,
           execute_action=None, owner_token=None):
    principal.require('grain-advisor', 'operator')
    if (not uuid(proposal_id) or not uuid(request_id) or decision not in {'approved', 'rejected'}
            or type(version) is not int or version < 1 or not isinstance(action_hash, str) or len(action_hash) != 64):
        raise PolicyDenied('invalid_decision')
    policy = load_policy()
    request_hash = digest({'proposal_id': proposal_id, 'decision': decision, 'action_hash': action_hash, 'version': version})
    conflict = None
    result = None
    with db.transaction():
        scope(db, principal)
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (':'.join((principal.tenant_id, principal.user_id, request_id)),))
        receipt = db.execute('SELECT request_hash,result FROM advisor_decision_receipts WHERE tenant_id=%s AND user_id=%s AND request_id=%s',
                             (principal.tenant_id, principal.user_id, request_id)).fetchone()
        if receipt:
            if receipt[0] != request_hash:
                raise Conflict('idempotency_conflict')
            if receipt[1].get('status') == 'expired':
                raise Conflict('proposal_expired')
            result = receipt[1]
        else:
            row = db.execute('''SELECT user_id::text,status,version,action_hash,expires_at<=clock_timestamp(),action
                                FROM action_proposals WHERE tenant_id=%s AND proposal_id=%s''',
                             (principal.tenant_id, proposal_id)).fetchone()
            if row is None:
                raise NotFound('proposal_not_found')
            if policy['tools']['propose_acknowledge_alert']['four_eyes'] and row[0] == principal.user_id:
                raise PolicyDenied('self_approval_denied')
            if row[1] != 'pending' or row[2] != version:
                raise Conflict('proposal_version_conflict')
            if row[3] != action_hash or digest(row[5]) != action_hash:
                raise Conflict('proposal_changed')
            status = 'expired' if row[4] else decision
            execution_status = 'pending' if status == 'approved' else 'not_applicable'
            updated = db.execute('''UPDATE action_proposals
                SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE %s END,
                    version=version+1,approver_id=%s,approver_role=%s,execution_status=%s
                WHERE tenant_id=%s AND proposal_id=%s AND version=%s AND status='pending' AND action_hash=%s
                RETURNING version,status,execution_status''',
                                 (status, principal.user_id, principal.role, execution_status,
                                  principal.tenant_id, proposal_id, version, action_hash)).fetchone()
            if updated is None:
                raise Conflict('proposal_version_conflict')
            status = updated[1]
            audit(db, principal, status, proposal_id)
            result = {'proposal_id': proposal_id, 'status': status, 'version': updated[0],
                      'action_hash': action_hash, 'execution_status': updated[2], 'execution_receipt': None}
            if status == 'expired':
                conflict = 'proposal_expired'
            db.execute('''INSERT INTO advisor_decision_receipts(tenant_id,user_id,request_id,request_hash,proposal_id,result)
                          VALUES(%s,%s,%s,%s,%s,%s::jsonb)''',
                       (principal.tenant_id, principal.user_id, request_id, request_hash, proposal_id, canonical(result)))
    if conflict:
        raise Conflict(conflict)
    if result.get('status') == 'approved' and execute_action is not None and owner_token:
        result.update(_execute_if_needed(db, principal, proposal_id, execute_action, owner_token))
    return result
