FROM postgres:16-bookworm

# PGDG dropped bullseye (the postgis/postgis:16-3.5 base); bookworm has all packages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       postgresql-16-postgis-3 \
       postgresql-16-pgvector \
       postgresql-16-cron \
  && rm -rf /var/lib/apt/lists/*

COPY init/ /docker-entrypoint-initdb.d/
