/**
 * Shared domain vocabulary (pure): scope, pricing, errors, time. Times in the domain are unix seconds
 * (integers, UTC) like the public API; amounts are bigint units of the row's currency (INV-5).
 */
import type { ErrorCode } from "@nearpay/spec";

/** Every read and write is scoped by account and mode (INV-8). `accountId` is the account uuid. */
export interface Scope {
  readonly accountId: string;
  readonly livemode: boolean;
}

export type BillingErrorCode = ErrorCode;

/**
 * A rule refused the request. The API layer maps it to the public error envelope (same code; params fill
 * the catalogue message; `param` names the offending request parameter).
 */
export class DomainError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    readonly params: Readonly<Record<string, string | number>> = {},
    readonly param?: string,
    /** A peer's rendered message, passed through unchanged (errors relayed from payments). */
    readonly upstreamMessage?: string,
  ) {
    super(upstreamMessage ?? `${code}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`);
    this.name = "DomainError";
  }
}

/** `state_conflict`: "The {object} is {state}; this action is not allowed." */
export const stateConflict = (object: string, state: string): DomainError =>
  new DomainError("state_conflict", { object, state });

export const missing = (object: string, id: string, param?: string): DomainError =>
  new DomainError("resource_missing", { object, id }, param);

export const invalid = (detail: string, param?: string): DomainError =>
  new DomainError("invalid_request", { detail }, param);

/** Fiat ISO 4217 lower-case code, or `asset` with an asset id. */
export interface Pricing {
  readonly currency: string;
  readonly assetId: string | null;
}

export const samePricing = (a: Pricing, b: Pricing): boolean =>
  a.currency === b.currency && (a.currency !== "asset" || a.assetId === b.assetId);

export const pricingLabel = (p: Pricing): string => (p.currency === "asset" ? `asset ${p.assetId}` : p.currency);

export type Metadata = Readonly<Record<string, string>>;

/** A metadata patch replaces the whole map (same rule as payments' updates); absent = unchanged. */
export function mergeMetadata(cur: Metadata, patch: Metadata | undefined): Metadata {
  return patch ?? cur;
}

export const DAY = 86_400;

/** Integer unix seconds of a millisecond clock reading. */
export const unix = (ms: number): number => Math.floor(ms / 1000);

/** Ordered list of distinct values (first occurrence wins). */
export function distinct<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
