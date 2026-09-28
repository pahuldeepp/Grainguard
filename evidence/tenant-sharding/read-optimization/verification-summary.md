# Final local verification

`make -e verify COMPOSE=true` passed on the final frozen source, with every PostgreSQL connection directed to isolated scratch port55591. The local Compose prerequisite was replaced because the scratch database was already initialized; every owner migration still ran through its normal migration target.

The target passed planning checks, all owner migrations, risk tests, formatting, lint, workspace type checks and tests, contact-schema checks, every configured Go vet/race suite, and the final Node/Go builds. Risk reported97 tests with1existing opt-in skip. Node test processes reported 1044 tests, 1018 passes, 0 failures and 26 existing opt-in skips.

External broker/service live flags were disabled to preserve the shared stack. This result provides isolated PostgreSQL and offline/unit proof; the independent isolated PG/Redis/authority/Go acceptance harness is recorded in `isolated-acceptance.txt`. It does not claim live external-provider or PgBouncer verification.

Shared jobs migration history remains preserved at version7dirty with nofoundation schema; no shared reset, force or repair was performed. The fresh jobs chain001–009 reaches9clean.

Local coverage completed independently against scratch port55592: the missing kafka-security coverage command was added and passed, and the remaining Go/Python continuation passed. The original literal command failure is retained in the coverage evidence. Weighted local instrumentation coverage is85.33%; this combines executable lines and Go statements and does not establish an every-workspace or SonarQube new-code threshold. The external SonarQube quality gate remains unverified.
