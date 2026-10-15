import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { Envelope, Header } from "@knct-log/core";

export interface StoredDevice {
  sign: CryptoKeyPair;
  kx: CryptoKeyPair;
  signPub: string;
  kxPub: string;
  name: string;
  createdAt: number;
}

export interface Endpoint {
  url: string;
  label: string;
}

export interface LocalRecord {
  id: string;
  group: string;
  kind: string;
  ts: number;
  header: Header;
  envelope: Envelope;
}

export interface OutboxItem {
  seq?: number;
  group: string;
  record: Envelope;
  recordId: string;
  blob?: { id: string };
  createdAt: number;
}

export interface LocalGroup {
  group: string;
  addedAt: number;
  /** 参加手続き中（join を送ったがまだメンバーとして読めない） */
  joining?: boolean;
}

interface Schema extends DBSchema {
  meta: { key: string; value: unknown };
  records: { key: string; value: LocalRecord; indexes: { group: string } };
  keys: { key: string; value: Uint8Array<ArrayBuffer> };
  cursors: { key: string; value: number };
  outbox: { key: number; value: OutboxItem };
  blobs: { key: string; value: { id: string; data: Uint8Array<ArrayBuffer>; at: number } };
  groups: { key: string; value: LocalGroup };
}

export type DB = IDBPDatabase<Schema>;

export function openLocalDb(name = "knct-log"): Promise<DB> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore("meta");
      db.createObjectStore("records", { keyPath: "id" }).createIndex("group", "group");
      db.createObjectStore("keys");
      db.createObjectStore("cursors");
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      db.createObjectStore("blobs", { keyPath: "id" });
      db.createObjectStore("groups", { keyPath: "group" });
    },
  });
}
