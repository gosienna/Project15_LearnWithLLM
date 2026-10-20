import type { Availability, LanguageModelAPI, LocalLlmNamespace } from "../types.ts";

export const MISSING_MODEL =
  "The page cannot see the local model. Enable this site in the Local LLM extension and reload.";

export const BLOCKED_MODEL =
  "The site is not allowed to use the model. Enable it in the Local LLM extension and reload.";

export interface BackendStatus {
  header: string;
  detail: string;
  composerEnabled: boolean;
  model: LanguageModelAPI | null;
}

interface BackendWindow {
  LanguageModel?: LanguageModelAPI;
  localLLM?: LocalLlmNamespace;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export function waitForLanguageModel(win: BackendWindow, timeout = 500): Promise<LanguageModelAPI | null> {
  if (win.LanguageModel) return Promise.resolve(win.LanguageModel);
  return new Promise((resolve) => {
    const done = () => {
      win.removeEventListener("localllm:ready", done);
      resolve(win.LanguageModel ?? null);
    };
    win.addEventListener("localllm:ready", done, { once: true });
    setTimeout(done, timeout);
  });
}

export async function loadBackendStatus(win: BackendWindow): Promise<BackendStatus> {
  const model = await waitForLanguageModel(win);
  if (!model) {
    return { header: "Local LLM", detail: MISSING_MODEL, composerEnabled: false, model: null };
  }

  let header = "Local LLM";
  try {
    const info = await win.localLLM?.info();
    if (info?.name) header = info.backend ? `${info.name} · ${info.backend}` : info.name;
  } catch {
    header = "Local LLM";
  }

  let availability: Availability = "unavailable";
  try {
    availability = await model.availability();
  } catch {
    availability = "unavailable";
  }

  if (availability === "unavailable") {
    return { header, detail: BLOCKED_MODEL, composerEnabled: false, model };
  }
  if (availability === "downloading") {
    return { header, detail: "Downloading…", composerEnabled: true, model };
  }
  if (availability === "downloadable") {
    return { header, detail: "The model downloads when you send.", composerEnabled: true, model };
  }
  return { header, detail: "Ready", composerEnabled: true, model };
}
