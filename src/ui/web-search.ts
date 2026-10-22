/** The learner's Web search switch. Off unless turned on; the extension also has to allow the site. */
export const WEB_SEARCH_STORAGE_KEY = "learnwithllm.webSearch";

export function readWebSearch(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(WEB_SEARCH_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeWebSearch(on: boolean, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(WEB_SEARCH_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private windows and blocked storage: the switch lasts until reload.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
