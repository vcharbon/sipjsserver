# Multi-stage build that produces a single image with two entrypoints:
#   - dist/main.js  → the B2BUA worker (current default CMD)
#   - dist-bin/bin/proxy.js → the SIP front proxy
#
# Helm charts in deploy/helm/ override `command:` per pod type.
#
# Stage 1: TypeScript build (full devDeps).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.bin.json tsconfig.test-harness.json ./
COPY src/ ./src/
COPY bin/ ./bin/
RUN npm run build

# Stage 1b: Native SIP parser (rvoip strict) compiled for musl so it
# loads inside the alpine runtime. The local host build produces a
# glibc .node which is incompatible with alpine's musl loader.
FROM rust:1-alpine AS native-build
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY repos/rvoip ./repos/rvoip
COPY native ./native
WORKDIR /build/native/sip-parser
# musl defaults to static linking; cdylib requires the dynamic crt.
ENV RUSTFLAGS="-C target-feature=-crt-static"
RUN cargo build --release

# Stage 2: Runtime image (production deps only).
FROM node:22-alpine
WORKDIR /app

RUN mkdir -p /data/cdr \
    && chown -R node:node /app /data

COPY package.json package-lock.json ./
# Reuse the build stage's fully-resolved node_modules rather than
# `npm ci --omit=dev`. effect + @effect/* are declared as peerDependencies
# (so the package's integrator consumers supply their own single Effect
# instance — see ADR-0016), and npm does NOT install a package's own
# peerDependencies for `npm ci`. A prod-only install would therefore drop
# effect/@effect (and other runtime deps that live in devDependencies, e.g.
# sip-parser), crash-looping the worker on ERR_MODULE_NOT_FOUND. Copying the
# build tree keeps the peerDependency contract intact and is lockfile-exact.
# Image size is a non-goal here (deploy-from-scratch, never published as the
# app); same node:22-alpine base + arch makes the tree directly reusable.
COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-bin ./dist-bin
COPY --chown=node:node native/sip-parser/index.cjs ./native/sip-parser/index.cjs
COPY --from=native-build --chown=node:node \
  /build/native/sip-parser/target/release/libsipjs_native_parser.so \
  ./native/sip-parser/sipjs-native-parser.linux-x64-musl.node

USER node

# Worker exposes UDP/5060 + UDP/5070 + admin/3002 by default. The proxy
# image overrides these via Helm values.
EXPOSE 5060/udp
EXPOSE 5070/udp
EXPOSE 3002

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/status || exit 1

# Default to the worker; the SIP-front-proxy chart overrides command.
CMD ["node", "dist/main.js"]
