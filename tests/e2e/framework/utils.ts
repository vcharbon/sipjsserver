/**
 * Shared utilities for the E2E test framework.
 */

/**
 * Filter out entries with undefined values to satisfy exactOptionalPropertyTypes.
 * Returns a new object containing only defined entries.
 */
export function defined<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result as T
}
