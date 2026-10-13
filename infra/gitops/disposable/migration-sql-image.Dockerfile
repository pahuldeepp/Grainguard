# Keep the exact verified PostgreSQL client base used by the RDS bootstrap
# chart. This separately built and signed reference gives the migration Jobs
# and acceptance gate a stable release artifact without changing upstream
# PostgreSQL contents.
FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
USER postgres
