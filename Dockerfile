ARG NODE_IMAGE=mirror.gcr.io/library/node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG NGINX_IMAGE=ghcr.io/nginx/nginx-unprivileged:1.30.4-alpine-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979
ARG SOURCE_DATE_EPOCH=0

# build-server env
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build-server-env
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY ./libs libs
COPY ./tsconfig.json .
COPY ./webpack.config.js .
COPY ./src src
RUN npm run bundle

# build-client env
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build-client-env
ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /build
COPY faucet-client/package*.json ./faucet-client/
COPY ./libs libs
COPY ./static static
RUN cd faucet-client && npm ci
COPY ./faucet-client faucet-client
RUN cd faucet-client && node ./build-client.js

# final stage
FROM ${NODE_IMAGE} AS node-runtime
FROM ${NGINX_IMAGE}

ARG SOURCE_REVISION=unbound
LABEL org.opencontainers.image.source="https://github.com/validaoxyz/hyperfaucet-public" \
      org.opencontainers.image.revision=${SOURCE_REVISION}

USER root

# Pin the security-fixed OpenSSL runtime packages independently of the
# vendor image refresh cadence. Alpine 3.24's current image still carries
# 3.5.7-r0, which is affected by CVE-2026-14456.
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0

# The pinned Nginx image already includes CA certificates.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=node-runtime /usr/lib/libstdc++.so.6* /usr/lib/

WORKDIR /app
COPY --from=build-server-env /build/bundle ./bundle
COPY --from=build-client-env /build/static ./static
COPY ./faucet-config.example.yaml .
RUN cp ./static/index.html ./static/index.seo.html \
    && chmod 777 ./static/index.seo.html

# Writable data directory for config, database, and other runtime files
RUN mkdir -p /data && chmod 777 /data

# nginx config: serves static files directly, proxies /api/ and /ws/ to node backend
COPY ./docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 ./docker/entrypoint.sh /entrypoint.sh

USER nginx
WORKDIR /data

EXPOSE 8080
ENTRYPOINT [ "/entrypoint.sh" ]
