FROM alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache pgbouncer=1.24.0-r0 \
 && addgroup -S pgbouncer && adduser -S -G pgbouncer pgbouncer
COPY pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
USER pgbouncer
EXPOSE 6432
ENTRYPOINT ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
