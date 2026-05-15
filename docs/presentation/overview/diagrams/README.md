# Presentation diagrams

The slide deck embeds pre-rendered SVGs from this directory. Edit the `.mmd` source files (or `.svg` for handcrafted ones), then re-render with `./render.sh`.

## Files

| Source | Output | Used in | Authoring |
|---|---|---|---|
| `topology.mmd` | `topology.svg` | slide 5 | mermaid flowchart |
| `call-hierarchy.mmd` | `call-hierarchy.svg` | slide 10 | mermaid flowchart |
| `leg-state-machine.mmd` | `leg-state-machine.svg` | slide 11 | mermaid flowchart |
| `invite-flow.mmd` | `invite-flow.svg` | slide 12 | mermaid sequenceDiagram |
| `tag-isolation.mmd` | `tag-isolation.svg` | slide 14 | mermaid flowchart |
| `in-dialog-routing.mmd` | `in-dialog-routing.svg` | slide 20 | mermaid sequenceDiagram |
| `proxy-ha.mmd` | `proxy-ha.svg` | slide 21 | mermaid flowchart |
| `worker-pipeline.mmd` | `worker-pipeline.svg` | slide 24 | mermaid flowchart |
| `replication-topology.svg` | (same file) | slide 31 | handcrafted SVG |
| `overload-tiers.mmd` | `overload-tiers.svg` | slide 36 | mermaid flowchart |

## Rendering

```bash
./render.sh
```

Requires `@mermaid-js/mermaid-cli` installed somewhere mmdc is discoverable. The script tries `./node_modules/.bin/mmdc`, `../node_modules/.bin/mmdc`, then `/tmp/node_modules/.bin/mmdc`.

Install with:
```bash
npm install --no-save @mermaid-js/mermaid-cli
```

## Why pre-rendered?

Loading Mermaid at runtime in reveal.js caused systematic text clipping: the SVG was scaled to the slide container while internal text/foreignObject coordinates stayed at native size. Pre-rendering with `mmdc` produces SVGs with correct internal coordinates so they scale cleanly via `max-width / max-height`.

## Theme

All diagrams share `mermaid-config.json`. To restyle the deck, edit that file and re-run `./render.sh`.
