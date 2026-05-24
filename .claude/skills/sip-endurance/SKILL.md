---
name: sip-endurance
description: sip endurance launch and monitor
---

Launch, monitor and verify a k8s based sip endurance test to make sure platform is in good shape using the (endurance)[../../../k8s-endurance.md] doc as reference
Use the args to determine the legnth, the standard cal lrate (by default 40), the abusive call reate (by default 1 caps) and wether or not chaos event are to be activated.
Generate runId with the current date + a short reason to have proper sorted
`npm run test:k8s:endurance -- --caps=20 --duration=30m --abuse-caps=1 --no-chaos --runId=xxx`


After launching the script, make sure that the k8s cluster is re-compiled and manages to start. Wait for 2 minutes and if not strarted investigate.
Verify the grafana http://localhost:3333 manage to get metrics and if sipp has bad result.

If test fail to start for easy to fix reason fix and relaunch, retry at least 3 times.

If chaos event are enables follow the run after each chaos event. If a chaos event put the platform in unrecoverable state , stop the run and investigate.

Once run is complete, provide a summary with:

- the full list of failed run and the reason why they failed - along with any fix description
- noticeable findings from the run.
- 




