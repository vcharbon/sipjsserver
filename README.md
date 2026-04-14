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


## good prompts


apply the sip anomaly expert to each of alice*.txt and bob*.txt file in test-report and generate a full ip anomaly report including all errors, the list of associated tests aggregated by error. Generate te report in new .md  file under docs/todos.
consider the following call, in the capture dont consider alice, bob, the B2BUA as a real B2BUA or endpoints, we mostly should consider if it is correct from RFC point of view for A to B call with other elements downstream and unstream that are hidden. 

