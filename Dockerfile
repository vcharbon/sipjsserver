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
COPY tsconfig.json tsconfig.build.json tsconfig.bin.json ./
COPY src/ ./src/
COPY bin/ ./bin/
RUN npm run build

# Stage 2: Runtime image (production deps only).
FROM node:22-alpine
WORKDIR /app

RUN mkdir -p /data/cdr \
    && chown -R node:node /app /data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-bin ./dist-bin

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
