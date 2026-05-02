The simulated worker is not good

 Real bugs uncovered while validating (option B fixes):

src/sip/TransactionLayer.ts: every forkDetach (sweep, retransmits, Timer B/F/H/J cleanup, ingest stream) → forkIn(layerScope). Without this, retx fibers outlived a closed worker scope.
src/call/TimerService.ts: forkDetach → forkIn(layerScope) on the timer fibers themselves.
src/call/CallState.ts: orphan-sweep daemon scope-bound similarly.
src/sip/SipRouter.ts: refer-async-http fork scope-bound.
src/b2bua/rules/framework/ActionExecutor.ts: executeScheduleTimer now de-dups state.call.timers by id, matching the in-memory MutableHashMap.set semantics — without this, recurring timers (keepalive, limiter_refresh) accumulated stale entries that got respawned with fireAt in the past after rehydration.