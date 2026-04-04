# SIP TS Server

This is mostly an attempt to explore how well Claude does in complex subjects. 100% vibe coded, not suitable for human consumption.

## 

npm run dev

```bash
npx serve /home/vince/sipjsserver/test-results/ -l 9888 &
```

## comile and deploy 

Dockerfile -- multi-stage build:

Stage 1: installs all deps, compiles TypeScript
Stage 2: production deps only (76 packages vs 128), copies compiled dist/, runs as non-root node user, health check via /status
Fix: --ignore-scripts needed because the prepare script (effect-language-service patch) requires a dev dependency
docker-compose.yml -- two services:

sip-b2bua on ports 5060/udp + 3002/tcp, read-only filesystem, init: true
redis (7-alpine), internal only, health-checked before app starts
SIP_LOCAL_IP is required with fail-fast error message
Usage:


SIP_LOCAL_IP=192.168.1.100 docker compose up -d