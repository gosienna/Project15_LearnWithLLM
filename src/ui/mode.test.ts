import { describe, expect, it } from "vitest";
import { MODE_STORAGE_KEY, readMode, writeMode } from "./mode.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("ui mode", () => {
  it("defaults to clean and round-trips debug", () => {
    const storage = memoryStorage();
    expect(readMode(storage)).toBe("clean");
    writeMode("debug", storage);
    expect(storage.getItem(MODE_STORAGE_KEY)).toBe("debug");
    expect(readMode(storage)).toBe("debug");
  });

  it("falls back to clean when storage throws or is missing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readMode(broken)).toBe("clean");
    expect(() => writeMode("debug", broken)).not.toThrow();
    expect(readMode(null)).toBe("clean");
  });
});
