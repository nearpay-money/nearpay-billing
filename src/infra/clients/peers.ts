/**
 * Clients for the services billing calls (lld/billing.md §1, §11 d4/d6), with billing's service token.
 * Every call is a spec route, so requests and responses are checked against the contract.
 *
 * | Target | Timeout | Retries | Breaker |
 * |---|---|---|---|
 * | payments `POST /internal/checkout_sessions` | 8 s | 1 (idempotent `in:<id>:s<n>`) | yes |
 * | payments `POST /internal/checkout_sessions/{id}/expire` | 8 s | 1 (idempotent) | yes |
 * | payments session / customer reads | 2 s | 1 | yes |
 * | identity settlement context | 1 s | 1 | yes |
 * | rails asset | 2 s | 1 | yes |
 */
import { HttpError, httpClient } from "@nearpay-internal/http";
import { encodeUuid } from "@nearpay-internal/ids";
import { fiatToJson, toBaseUnits } from "@nearpay-internal/money";
import {
  createInvoiceCheckoutSession,
  expireInvoiceCheckoutSession,
  getInternalAsset,
  getInternalCheckoutSession,
  getInternalCustomer,
  getSettlementContext,
} from "@nearpay-internal/spec";
import type {
  AssetsPort,
  InvoiceSessionRequest,
  MerchantFacts,
  MerchantPort,
  PaymentsPort,
  SessionFacts,
} from "../../app/ports.js";
import { type BillingErrorCode, DomainError, type Scope } from "../../domain/shared.js";

const BREAKER = { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 } as const;

export interface PeerOptions {
  readonly serviceToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

const acct = (uuid: string) => `acct_${encodeUuid(uuid)}` as `acct_${string}`;
const mode = (lm: boolean) => (lm ? "true" : "false") as never;

/** A NearPay error from a peer → the same code (and message) for the caller; anything else rethrows. */
export function relay(e: unknown): never {
  if (e instanceof HttpError && e.error?.code)
    throw new DomainError(e.error.code as BillingErrorCode, {}, e.error.param ?? undefined, e.error.message);
  throw e;
}

const isCode = (e: unknown, code: string, status?: number) =>
  e instanceof HttpError && e.error?.code === code && (status === undefined || e.status === status);

function sessionFacts(s: { id: string; status: string; expires_at: number; invoice?: string | null }): SessionFacts {
  return { id: s.id, status: s.status, expiresAt: s.expires_at, invoiceId: s.invoice ?? null };
}

export function paymentsClient(o: PeerOptions & { baseUrl: string }): PaymentsPort {
  const common = {
    target: "payments",
    baseUrl: o.baseUrl,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  };
  const write = httpClient({ ...common, timeoutMs: 8_000, attempts: 2, breaker: BREAKER });
  const read = httpClient({ ...common, timeoutMs: 2_000, attempts: 2, breaker: BREAKER });
  return {
    async getCustomer(scope: Scope, customerId: string) {
      try {
        const c = await read.call(getInternalCustomer, { params: { id: customerId as `cus_${string}` } });
        if (c.account_id !== acct(scope.accountId) || c.livemode !== scope.livemode) return undefined;
        return { id: c.id, email: c.email, name: c.name, deleted: c.deleted };
      } catch (e) {
        if (isCode(e, "resource_missing")) return undefined;
        return relay(e);
      }
    },
    async createInvoiceSession(req: InvoiceSessionRequest, idempotencyKey: string) {
      try {
        const s = await write.call(createInvoiceCheckoutSession, {
          body: {
            account_id: acct(req.scope.accountId),
            livemode: req.scope.livemode,
            invoice: req.invoiceId as `in_${string}`,
            amount: req.currency === "asset" ? toBaseUnits(req.amount) : fiatToJson(req.amount),
            currency: req.currency as never,
            ...(req.assetId ? { asset_id: req.assetId as never } : {}),
            customer: req.customerId as `cus_${string}`,
            description: req.description,
            ...(req.settlementDestinationId
              ? { settlement_destination: req.settlementDestinationId as `sd_${string}` }
              : {}),
            success_url: req.successUrl,
            expires_at: new Date(req.expiresAt * 1000).toISOString(),
            ...(req.locale ? { locale: req.locale } : {}),
            metadata: { ...req.metadata },
          },
          idempotencyKey,
        });
        if (!s.client_secret) throw new Error(`payments returned session ${s.id} without its client secret`);
        return { kind: "created" as const, session: sessionFacts(s), clientSecret: s.client_secret };
      } catch (e) {
        if (isCode(e, "state_conflict", 409)) return { kind: "conflict" as const };
        return relay(e);
      }
    },
    async getSession(sessionId: string) {
      try {
        return sessionFacts(
          await read.call(getInternalCheckoutSession, { params: { id: sessionId as `cs_${string}` } }),
        );
      } catch (e) {
        return relay(e);
      }
    },
    async expireSession(sessionId, reason) {
      try {
        return sessionFacts(
          await write.call(expireInvoiceCheckoutSession, {
            params: { id: sessionId as `cs_${string}` },
            body: { reason },
            idempotencyKey: `expire:${sessionId}:${reason}`,
          }),
        );
      } catch (e) {
        return relay(e);
      }
    },
  };
}

export function identityMerchant(o: PeerOptions & { baseUrl: string }): MerchantPort {
  const c = httpClient({
    target: "identity",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    async context(scope): Promise<MerchantFacts> {
      try {
        const ctx = await c.call(getSettlementContext, {
          params: { id: acct(scope.accountId) },
          query: { livemode: mode(scope.livemode) },
        });
        return {
          // the ops-approved legal name once verified (ADR-0020 d3), else the display name
          displayName: ctx.account.verified_legal_name ?? ctx.account.display_name,
          liveEnabled: ctx.account.live_enabled,
          liveMissing: ctx.account.live_enabled ? null : "kyb_or_live_destination",
          destinations: ctx.destinations
            .filter((d) => d.status === "active")
            .map((d) => ({ id: d.id, assetId: d.asset_id, chain: d.chain, type: d.type })),
          defaults: { ...ctx.defaults },
        };
      } catch (e) {
        return relay(e);
      }
    },
  };
}

export function railsAssets(o: PeerOptions & { baseUrl: string }): AssetsPort {
  const c = httpClient({
    target: "rails",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const cache = new Map<string, { at: number; v: Awaited<ReturnType<AssetsPort["asset"]>> }>();
  return {
    async asset(assetId) {
      const hit = cache.get(assetId);
      if (hit && Date.now() - hit.at < 300_000) return hit.v;
      try {
        const a = await c.call(getInternalAsset, { params: { asset_id: assetId as never } });
        const v = { assetId: a.asset_id, symbol: a.symbol, decimals: a.decimals };
        cache.set(assetId, { at: Date.now(), v });
        return v;
      } catch (e) {
        if (isCode(e, "asset_unsupported") || isCode(e, "resource_missing")) {
          cache.set(assetId, { at: Date.now(), v: undefined });
          return undefined;
        }
        return relay(e);
      }
    },
  };
}
