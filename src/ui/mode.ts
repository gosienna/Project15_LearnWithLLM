/** Clean shows only what helps the learner; Debug shows every step of a turn and the raw board. */
export type UiMode = "clean" | "debug";

export const MODE_STORAGE_KEY = "learnwithllm.mode";

export function readMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): UiMode {
  try {
    return storage?.getItem(MODE_STORAGE_KEY) === "debug" ? "debug" : "clean";
  } catch {
    return "clean";
  }
}

export function writeMode(mode: UiMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Private windows and blocked storage: the mode lasts until reload.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
