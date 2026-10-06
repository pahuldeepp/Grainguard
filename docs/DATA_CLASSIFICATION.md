# Control-plane data classification (Stage 09a)

| Data | Class | Storage and handling | Retention/deletion hook |
|---|---|---|---|
| IdP issuer and opaque subject | Restricted identity | `greenguard_control.identities`; never emitted in membership events or logs | Identity deletion requires membership/audit retention review and provider unlinking |
| Invitation email | Personal | Only normalized SHA-256 digest in `invitations`; raw email is request-local | Expired invitations may be purged only under an approved retention job |
| Invitation token | Secret | 256-bit random, returned once; only SHA-256 digest stored | Single use, 72-hour expiry; no logs or idempotency receipt copy |
| Membership state, role, actor and version | Restricted authorization | Forced RLS, tenant filter, append-only audit and outbox | Revoke rather than delete; subject erasure needs a documented audit redaction process |
| Service lookup credential | Secret | Environment/secret manager only; never in event or audit payload | Rotate with overlap and verifier restart procedure |

Stage 09e owns export redaction and retention execution. Stage 14 owns proven deletion
across backups and downstream projections. This register prevents either slice from
treating tenant membership history as disposable operational data.
