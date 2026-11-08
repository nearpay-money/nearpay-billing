/** Prefixed public ids (`<prefix>_<TypeID of a UUIDv7>`, foundations §5) for billing's objects. */
import { encodeUuid, uuidv7 } from "@nearpay-internal/ids";
import type { IdKind } from "../app/ports.js";

export const newBillingId = (kind: IdKind): string => `${kind}_${encodeUuid(uuidv7())}`;
