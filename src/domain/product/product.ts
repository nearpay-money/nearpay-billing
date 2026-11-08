/** Product (lld/billing.md §5): create, update/archive; no delete. Pure. */
import { type Metadata, mergeMetadata, type Scope } from "../shared.js";

export interface Product extends Scope {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly metadata: Metadata;
  readonly created: number;
  readonly updated: number;
  readonly version: number;
}

export interface ProductCreate {
  readonly name: string;
  readonly description?: string | undefined;
  readonly active?: boolean | undefined;
  readonly metadata?: Metadata | undefined;
}

export interface ProductPatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly active?: boolean | undefined;
  readonly metadata?: Metadata | undefined;
}

export function newProduct(scope: Scope, id: string, now: number, input: ProductCreate): Product {
  return {
    ...scope,
    id,
    name: input.name,
    description: input.description ?? null,
    active: input.active ?? true,
    metadata: input.metadata ?? {},
    created: now,
    updated: now,
    version: 0,
  };
}

export function patchProduct(cur: Product, patch: ProductPatch, now: number): Product {
  return {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    metadata: mergeMetadata(cur.metadata, patch.metadata),
    updated: now,
  };
}
