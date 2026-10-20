import type { TopicRecord } from "../types.ts";

const DB_NAME = "learn-with-llm";
const DB_VERSION = 1;
const STORE = "topics";

export interface TopicRepository {
  list(): Promise<TopicRecord[]>;
  get(id: string): Promise<TopicRecord | undefined>;
  put(topic: TopicRecord): Promise<void>;
  delete(id: string): Promise<void>;
  mostRecent(): Promise<TopicRecord | undefined>;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("byUpdated", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
  });
}

export function createRepository(db: IDBDatabase): TopicRepository {
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

  return {
    async list() {
      const rows = await requestToPromise(store("readonly").index("byUpdated").getAll());
      return (rows as TopicRecord[]).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      const row = await requestToPromise(store("readonly").get(id));
      return (row as TopicRecord | undefined) ?? undefined;
    },
    async put(topic) {
      await requestToPromise(store("readwrite").put(topic));
    },
    async delete(id) {
      await requestToPromise(store("readwrite").delete(id));
    },
    async mostRecent() {
      const index = store("readonly").index("byUpdated");
      return new Promise((resolve, reject) => {
        const cursor = index.openCursor(null, "prev");
        cursor.onsuccess = () => {
          const result = cursor.result;
          resolve((result?.value as TopicRecord | undefined) ?? undefined);
        };
        cursor.onerror = () => reject(cursor.error ?? new Error("Could not read topics."));
      });
    },
  };
}

export function createEmptyTopic(now = Date.now()): TopicRecord {
  return {
    id: crypto.randomUUID(),
    title: "New topic",
    documentMarkdown: "",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}
