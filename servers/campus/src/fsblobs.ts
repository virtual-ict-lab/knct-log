import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BlobStore } from "@knct-log/server-app";

const ID = /^[A-Za-z0-9_-]{43}$/;

/** 暗号化済み blob をローカルディスクに置く */
export function fsBlobStore(dir: string): BlobStore {
  const path = (id: string) => {
    if (!ID.test(id)) throw new Error("invalid blob id");
    return join(dir, id.slice(0, 2), id);
  };
  return {
    async put(id, data) {
      const p = path(id);
      await mkdir(join(dir, id.slice(0, 2)), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, p);
    },
    async get(id) {
      const p = path(id);
      try {
        await stat(p);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
    },
    async delete(ids) {
      await Promise.all(ids.map((id) => rm(path(id), { force: true })));
    },
  };
}
