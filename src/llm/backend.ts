import type { Availability, LanguageModelAPI, LocalLlmNamespace, ModelInfo } from "../types.ts";

export const MODEL_HEADER = "Language model";
export const MODEL_STORAGE_KEY = "learn-with-llm.model";

export const MISSING_MODEL = "The page cannot see a model. Enable this site in the extension and reload.";

export const BLOCKED_MODEL = "This site is not allowed to use the model. Enable it in the extension and reload.";

export interface BackendStatus {
  header: string;
  detail: string;
  composerEnabled: boolean;
  model: LanguageModelAPI | null;
  models: ModelInfo[];
  /** Why `models` is empty. Null when the list came back from `localLLM.models()`. */
  modelNote: string | null;
  chosen: ModelInfo | null;
}

export interface ModelListing {
  models: ModelInfo[];
  note: string | null;
}

/** Chrome already has LanguageModel, so the extension stub does not install `localLLM`. */
export const NATIVE_ONLY_NOTE =
  "This page is using Chrome's built-in model. The extension lists models with localLLM.models(), and it adds that only after you turn on “Override Chrome's native LanguageModel” and reload.";

export const EXTENSION_MISSING_NOTE = "This page cannot see the extension. Enable this site in the extension and reload.";

export const OLD_EXTENSION_NOTE = "This extension has no localLLM.models(). Reload the extension, then reload this page.";

export const EMPTY_MODELS_NOTE =
  "localLLM.models() returned no models. A local model is listed only after its weights are downloaded, and a cloud model only when that provider is allowed for this site.";

export interface BackendWindow {
  LanguageModel?: LanguageModelAPI;
  localLLM?: LocalLlmNamespace;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The extension offers localLLM.search(). Whether this site may use it is only known when it runs. */
export function searchAvailable(win: Pick<BackendWindow, "localLLM">): boolean {
  return typeof win.localLLM?.search === "function";
}

export function waitForLanguageModel(win: BackendWindow, timeout = 500): Promise<LanguageModelAPI | null> {
  if (win.LanguageModel) return Promise.resolve(win.LanguageModel);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.removeEventListener("localllm:ready", done);
      clearTimeout(timer);
      resolve(win.LanguageModel ?? null);
    };
    win.addEventListener("localllm:ready", done, { once: true });
    const timer = setTimeout(done, timeout);
  });
}

function waitForLocalLlm(win: BackendWindow, timeout: number): Promise<LocalLlmNamespace | null> {
  if (win.localLLM || timeout <= 0) return Promise.resolve(win.localLLM ?? null);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.removeEventListener("localllm:ready", done);
      clearTimeout(timer);
      resolve(win.localLLM ?? null);
    };
    win.addEventListener("localllm:ready", done, { once: true });
    const timer = setTimeout(done, timeout);
  });
}

export function chooseModel(models: ModelInfo[], savedId: string | null): ModelInfo | null {
  if (savedId) {
    const saved = models.find((item) => item.id === savedId);
    if (saved) return saved;
  }
  return models.find((item) => item.default) ?? models[0] ?? null;
}

export function readSavedModelId(storage: Pick<Storage, "getItem"> | null = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(MODEL_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeSavedModelId(id: string, storage: Pick<Storage, "setItem"> | null = globalThis.localStorage): void {
  try {
    storage?.setItem(MODEL_STORAGE_KEY, id);
  } catch {
    // Private mode can refuse storage. The choice still applies for this page load.
  }
}

function failureNote(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "localLLM.models() failed.";
}

async function currentBackend(llm: LocalLlmNamespace): Promise<string | null> {
  try {
    const info = await llm.info();
    if (!info?.name) return null;
    return info.backend ? `${info.name} (${info.backend})` : info.name;
  } catch {
    return null;
  }
}

/**
 * The page call is `await window.localLLM.models()`. Chrome's native LanguageModel has no
 * model list; the extension adds `localLLM` only when it overrides that API.
 */
export async function listAvailableModels(win: BackendWindow, waitMs = 800): Promise<ModelListing> {
  if (!win.localLLM) await waitForLocalLlm(win, win.LanguageModel ? 0 : waitMs);
  const llm = win.localLLM;
  if (!llm) return { models: [], note: win.LanguageModel ? NATIVE_ONLY_NOTE : EXTENSION_MISSING_NOTE };
  if (typeof llm.models !== "function") return { models: [], note: OLD_EXTENSION_NOTE };
  try {
    const models = await llm.models();
    if (!Array.isArray(models)) return { models: [], note: "localLLM.models() did not return a list." };
    if (models.length === 0) {
      const backend = await currentBackend(llm);
      const note = backend ? `${EMPTY_MODELS_NOTE} The extension reports ${backend}.` : EMPTY_MODELS_NOTE;
      return { models: [], note };
    }
    return { models, note: null };
  } catch (error) {
    return { models: [], note: failureNote(error) };
  }
}

function statusDetail(chosen: ModelInfo | null, availabilityText: string): string {
  const where = [chosen?.provider, chosen?.engine].filter(Boolean).join(" · ");
  return where ? `${where} · ${availabilityText}` : availabilityText;
}

export async function loadBackendStatus(win: BackendWindow, savedId: string | null = null): Promise<BackendStatus> {
  const model = await waitForLanguageModel(win);
  const listing = await listAvailableModels(win);
  const models = listing.models;
  const modelNote = listing.note;
  const chosen = chooseModel(models, savedId);
  if (!model) {
    return { header: MODEL_HEADER, detail: MISSING_MODEL, composerEnabled: false, model: null, models, modelNote, chosen };
  }

  let header = chosen?.name || MODEL_HEADER;
  if (!chosen) {
    try {
      const info = await win.localLLM?.info();
      if (info?.name) header = info.name;
    } catch {
      header = MODEL_HEADER;
    }
  }

  let availability: Availability = "unavailable";
  try {
    availability = await model.availability();
  } catch {
    availability = "unavailable";
  }

  const base = { header, model, models, modelNote, chosen };
  if (availability === "unavailable") {
    return { ...base, detail: BLOCKED_MODEL, composerEnabled: false };
  }
  if (availability === "downloading") {
    return { ...base, detail: statusDetail(chosen, "Downloading…"), composerEnabled: true };
  }
  if (availability === "downloadable") {
    return { ...base, detail: statusDetail(chosen, "The model downloads when you send."), composerEnabled: true };
  }
  return { ...base, detail: statusDetail(chosen, "Ready"), composerEnabled: true };
}
