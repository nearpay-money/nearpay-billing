/**
 * Invoice PDF object store (lld/billing.md §8 `NP_OBJECT_STORE`). v1 ships the filesystem store
 * (`fs:/data/invoices`, a Docker volume on the single-host server, ADR-0015); writes are atomic
 * (temp file + rename). Keys are relative paths built by billing (`invoices/<account>/<mode>/<id>/<status>.pdf`).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { ObjectStore } from "../app/ports.js";

export function objectStore(url: string): ObjectStore {
  if (!url.startsWith("fs:"))
    throw new Error(`NP_OBJECT_STORE ${url.split(":")[0]}: only fs:/<dir> is supported in v1`);
  const root = normalize(url.slice(3));
  const path = (key: string) => {
    const p = normalize(join(root, key));
    if (!p.startsWith(root + sep) || key.includes("\0")) throw new Error(`invalid object key ${key}`);
    return p;
  };
  return {
    async put(key, bytes) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(path(key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
  };
}
