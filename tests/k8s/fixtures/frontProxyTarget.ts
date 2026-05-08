/**
 * SIP front-proxy target address for in-cluster sipp traffic.
 *
 * With `sip-front-proxy.vip.enabled` (the test default — see
 * `tests/k8s/values/sip-front-proxy.yaml`), the proxy listener binds
 * to the VIP only. The Service DNS `sip-front-proxy:5060` DNATs to
 * pod/node IPs where nothing is listening, so sipp UDP retrans-times
 * out. Tests must target the VIP directly. Address matches
 * `tests/k8s/values/sip-front-proxy.yaml` (`vip.address`).
 */

export const FRONT_PROXY_VIP_HOST = "172.20.255.250"
export const FRONT_PROXY_VIP_PORT = 5060
export const FRONT_PROXY_VIP_TARGET = `${FRONT_PROXY_VIP_HOST}:${FRONT_PROXY_VIP_PORT}`
