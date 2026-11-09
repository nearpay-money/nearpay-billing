/** Builders for mandate unit and property tests. */
import {
  type CreatedData,
  type EventMeta,
  fromCreated,
  type Mandate,
  NO_KEEPER,
} from "../../src/domain/mandate/mandate.js";
import type { LinkInput, TermsInput } from "../../src/domain/mandate/terms.js";
import { newSubscription, type Subscription } from "../../src/domain/subscription/subscription.js";
import { SCOPE, T0 } from "./fixtures.js";

export const VAULT = "vault.sandbox.near";
export const SUB_ID = "sub_00000000000000000000000001";

export function autoDebitSub(o: Partial<Subscription> = {}): Subscription {
  return {
    ...newSubscription(SCOPE, SUB_ID, T0, {
      customerId: "cus_00000000000000000000000001",
      collectionMethod: "auto_debit",
      items: [{ id: "si_1", priceId: "price_1", quantity: 1, taxRateIds: null }],
      pricing: { currency: "usd", assetId: null },
      recurring: { interval: "month", intervalCount: 1 },
    }),
    status: "active",
    latestInvoiceId: "in_00000000000000000000000001",
    ...o,
  };
}

export const DEST = { id: "sd_usdc", assetId: "nep141:usdc.near", type: "intents_account", address: "acme.near" };

/** Terms input for a $10.00/month USD subscription paid in USDC (6 decimals), fee 100 bps. */
export function termsInput(o: Partial<TermsInput> = {}): TermsInput {
  return {
    subscription: autoDebitSub(),
    perPeriodTotal: 1000n,
    token: undefined,
    tokenDecimals: (t) => (t === "usdc.near" || t === "usdt.near" ? 6 : undefined),
    usdTokens: ["usdc.near", "usdt.near"],
    allowedTokens: ["usdc.near", "usdt.near"],
    maxFeeBps: 500,
    feeBps: 100,
    destinations: [DEST],
    defaults: { "*": DEST.id },
    latestInvoicePayable: true,
    now: T0,
    ...o,
  };
}

export function linkInput(o: Partial<LinkInput> = {}): LinkInput {
  const { token: _t, ...rest } = termsInput();
  return { ...rest, vaultLivemode: false, alreadyLinked: false, ...o };
}

/** The `mandate_created` the prepared terms of `termsInput()` produce. */
export function created(o: Partial<CreatedData> = {}): CreatedData {
  return {
    onchainId: 7,
    payer: "alice.near",
    merchantReceiver: "acme.near",
    token: "usdc.near",
    amountPerPeriod: 10_000_000n,
    periodSecs: 2_629_746,
    startAtNs: BigInt(T0) * 1_000_000_000n,
    maxPeriods: null,
    feeBps: 100,
    extRef: SUB_ID,
    receiverKind: "intents_account",
    balance: 30_000_000n,
    ...o,
  };
}

export function meta(o: Partial<EventMeta> = {}): EventMeta {
  return {
    vaultContract: VAULT,
    livemode: false,
    blockHeight: 100,
    blockTime: T0,
    txHash: "txhash",
    receiptId: "receipt",
    ...o,
  };
}

export function mandate(o: Partial<Mandate> = {}, d: Partial<CreatedData> = {}): Mandate {
  return {
    ...fromCreated(
      {
        id: "md_00000000000000000000000001",
        accountId: SCOPE.accountId,
        subscriptionId: SUB_ID,
        customerId: "cus_00000000000000000000000001",
        link: { linked: true, settlementDestinationId: DEST.id },
        now: T0,
      },
      created(d),
      meta(),
    ),
    keeper: NO_KEEPER,
    ...o,
  };
}
