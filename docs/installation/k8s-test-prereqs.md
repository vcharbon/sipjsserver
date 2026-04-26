# K8s test environment — Linux prerequisites

What you need installed on a Linux dev box (incl. WSL2) before running
`npm run test:k8s`. This file documents the host setup. Cluster
configuration, Helm charts, and scenarios live in `tests/k8s/`.

## CLI tools

Install to `~/.local/bin` (no sudo); all three are static binaries.

```bash
# kind v0.30.0
curl -sSLo ~/.local/bin/kind https://kind.sigs.k8s.io/dl/v0.30.0/kind-linux-amd64
chmod +x ~/.local/bin/kind

# kubectl (latest stable)
curl -sSLo ~/.local/bin/kubectl "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x ~/.local/bin/kubectl

# helm v3.18.4
curl -sSL https://get.helm.sh/helm-v3.18.4-linux-amd64.tar.gz \
  | tar -xzO linux-amd64/helm > ~/.local/bin/helm
chmod +x ~/.local/bin/helm

# Verify
kind --version && kubectl version --client=true | head -1 && helm version --short
```

`docker` and `sipp` (host binary, optional — only used for ad-hoc manual
calls outside the cluster) come from the system package manager.

## Kernel: bump inotify limits (REQUIRED)

Default `fs.inotify.max_user_instances=128` is below what kind needs for
a multi-node cluster. Without this, `kube-proxy` pods crashloop with
`failed complete: too many open files` and `ClusterIP` Services (incl.
CoreDNS at `10.96.0.10`) become unreachable from most nodes — the
symptom is `getaddrinfo EAI_AGAIN <name>` from any pod.

```bash
# immediate (lost on reboot)
sudo sysctl -w fs.inotify.max_user_instances=8192 fs.inotify.max_user_watches=524288

# persistent
echo -e "fs.inotify.max_user_instances=8192\nfs.inotify.max_user_watches=524288" \
  | sudo tee /etc/sysctl.d/99-kind.conf
```

This is a one-time host change, not per-cluster.

## Docker daemon

Docker 24+ is fine. The K8s tier sizes for ~6–8 GB RAM and 4–6 cores
during bring-up; on Docker Desktop / WSL2 give the VM 8 GB+ via
`.wslconfig` or Docker Desktop → Resources.

## Verify

```bash
# inotify
cat /proc/sys/fs/inotify/max_user_instances     # → 8192
cat /proc/sys/fs/inotify/max_user_watches       # → 524288

# Docker
docker info | grep -E 'Server Version|Total Memory|CPUs'

# CLIs
kind --version
kubectl version --client=true | head -1
helm version --short
```

Once those check out, `npm run test:k8s:up` should bring the cluster up
in ~30 s (warm Docker), and `npm run test:k8s` runs the K8s-tier
invariant suite. See [docs/todos/K8S_DEV_TEST.md](../todos/K8S_DEV_TEST.md)
for the full plan and `tests/k8s/` for the harness.
