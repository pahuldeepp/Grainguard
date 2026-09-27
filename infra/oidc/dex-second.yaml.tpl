# Independent issuer for Stage 09g multi-issuer tests. Uses the same local
# password only in the opt-in test environment; its signing keys are separate.
issuer: http://127.0.0.1:5557/dex
storage:
  type: memory
web:
  http: 0.0.0.0:5557
expiry:
  idTokens: "{{ getenv "OIDC_TOKEN_TTL" "5m" }}"
  signingKeys: "6h"
oauth2:
  responseTypes: ["code"]
  skipApprovalScreen: true
  passwordConnector: local
enablePasswordDB: true
staticClients:
  - id: greenguard-dashboard
    name: GreenGuard second issuer dashboard
    public: true
    redirectURIs:
      - http://127.0.0.1:5173/auth/callback
      - http://localhost:5173/auth/callback
staticPasswords:
  - email: alice@greenguard.test
    hash: '{{ getenv "OIDC_DEV_PASSWORD" | crypto.Bcrypt }}'
    username: alice
    userID: user-alice
