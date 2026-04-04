# Stage 1: Build TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app

RUN mkdir -p /data/cdr \
    && chown -R node:node /app /data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 5060/udp
EXPOSE 5070/udp
EXPOSE 3002

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/status || exit 1

CMD ["node", "dist/main.js"]
