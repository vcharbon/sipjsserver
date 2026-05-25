/**
 * Shared runtime utilities for the effect-layer-test pattern
 * (ADR-0013). Pull from here when composing contract-wrapped Layers
 * outside per-Tag forwarders.
 *
 * Currently exposes `withCanonicalContracts` — the canonical-order
 * composer per D7. Per-Tag `Tag.withAllContracts(options)` forwarders
 * call into this helper so the order is centralised and impossible to
 * permute by accident.
 */

import type { Layer, ServiceMap } from "effect"

/**
 * Wrapper functions accept the inner Layer and return a same-Tag
 * Layer. Generic-by-design: each layer's `contracts.ts` exports its
 * own `propertyTest` / `paranoidInputs` / `scopedAudit`, and supplies
 * them here via the options.
 *
 * The `options` shape is generic over the layer-specific option
 * payloads. Each entry is `{ wrap, opts }` so the per-Tag forwarder
 * passes its own wrappers without this helper having to know which
 * layer it's composing.
 */
export interface CanonicalContractsOptions<
  S,
  P = unknown,
  PI = unknown,
  SA = unknown,
> {
  readonly propertyTest?: {
    readonly wrap: (
      inner: Layer.Layer<S>,
      opts?: P,
    ) => Layer.Layer<S>
    readonly opts?: P
  }
  readonly paranoidInputs?: {
    readonly wrap: (
      inner: Layer.Layer<S>,
      opts?: PI,
    ) => Layer.Layer<S>
    readonly opts?: PI
  }
  readonly scopedAudit?: {
    readonly wrap: (
      inner: Layer.Layer<S>,
      opts?: SA,
    ) => Layer.Layer<S>
    readonly opts?: SA
  }
}

/**
 * Compose contract wrappers in the canonical order:
 *
 *   propertyTest(paranoidInputs(scopedAudit(impl)))
 *
 * Each option is optional — undefined entries skip that wrapper.
 * `parity` is NOT in this helper; build the parity layer first and
 * pass it as `impl`.
 *
 * The `tag` argument exists for symmetry with per-Tag forwarders and
 * for future per-tag-level diagnostics; it is not consumed by the
 * composer itself.
 */
export const withCanonicalContracts = <S, P, PI, SA>(
  _tag: ServiceMap.Key<S, any>,
  impl: Layer.Layer<S>,
  options: CanonicalContractsOptions<S, P, PI, SA>,
): Layer.Layer<S> => {
  let layer: Layer.Layer<S> = impl
  if (options.scopedAudit !== undefined) {
    layer = options.scopedAudit.wrap(layer, options.scopedAudit.opts)
  }
  if (options.paranoidInputs !== undefined) {
    layer = options.paranoidInputs.wrap(layer, options.paranoidInputs.opts)
  }
  if (options.propertyTest !== undefined) {
    layer = options.propertyTest.wrap(layer, options.propertyTest.opts)
  }
  return layer
}
