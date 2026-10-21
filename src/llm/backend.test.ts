import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../types.ts";
import {
  EMPTY_MODELS_NOTE,
  EXTENSION_MISSING_NOTE,
  NATIVE_ONLY_NOTE,
  OLD_EXTENSION_NOTE,
  chooseModel,
  listAvailableModels,
  type BackendWindow,
} from "./backend.ts";

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    backend: "local",
    provider: "Local",
    default: false,
    input: ["text"],
    output: ["text"],
    contextWindow: 8192,
    inputQuota: 8192,
    maxOutputTokens: 2048,
    tools: "prompted",
    price: { input: 0, output: 0 },
    ...extra,
  };
}

function page(partial: Partial<BackendWindow> = {}): BackendWindow {
  return {
    addEventListener() {},
    removeEventListener() {},
    ...partial,
  };
}

describe("listAvailableModels", () => {
  it("returns the array from localLLM.models()", async () => {
    const models = [model("local:qwen", { default: true, name: "Qwen" })];
    const listing = await listAvailableModels(
      page({ localLLM: { info: async () => ({ name: "Qwen" }), models: async () => models } }),
      0,
    );
    expect(listing).toEqual({ models, note: null });
  });

  it("surfaces a rejection from localLLM.models() instead of an empty list", async () => {
    const listing = await listAvailableModels(
      page({
        localLLM: {
          info: async () => ({ name: "Qwen" }),
          models: async () => {
            throw new DOMException("This site is not enabled for the local model", "NotAllowedError");
          },
        },
      }),
      0,
    );
    expect(listing.models).toEqual([]);
    expect(listing.note).toBe("This site is not enabled for the local model");
  });

  it("explains an empty list and names the backend from info()", async () => {
    const listing = await listAvailableModels(
      page({ localLLM: { info: async () => ({ name: "Qwen2.5 0.5B", backend: "wllama" }), models: async () => [] } }),
      0,
    );
    expect(listing.models).toEqual([]);
    expect(listing.note).toContain(EMPTY_MODELS_NOTE);
    expect(listing.note).toContain("Qwen2.5 0.5B (wllama)");
  });

  it("says when the extension stub did not install localLLM.models()", async () => {
    const listing = await listAvailableModels(page({ localLLM: { info: async () => ({ name: "Qwen" }) } }), 0);
    expect(listing.note).toBe(OLD_EXTENSION_NOTE);
  });

  it("says when Chrome's built-in model left localLLM unset", async () => {
    const listing = await listAvailableModels(page({ LanguageModel: {} as BackendWindow["LanguageModel"] }), 0);
    expect(listing.note).toBe(NATIVE_ONLY_NOTE);
  });

  it("says when the extension is not on the page", async () => {
    const listing = await listAvailableModels(page(), 0);
    expect(listing.note).toBe(EXTENSION_MISSING_NOTE);
  });
});

describe("chooseModel", () => {
  it("keeps a saved id that is still available", () => {
    const models = [model("local:a", { default: true }), model("anthropic:haiku", { provider: "Anthropic" })];
    expect(chooseModel(models, "anthropic:haiku")?.id).toBe("anthropic:haiku");
  });

  it("falls back to the default when the saved id is gone", () => {
    const models = [model("local:a"), model("local:b", { default: true })];
    expect(chooseModel(models, "missing")?.id).toBe("local:b");
  });

  it("uses the first model when none is marked default", () => {
    expect(chooseModel([model("local:a"), model("local:b")], null)?.id).toBe("local:a");
    expect(chooseModel([], "local:a")).toBeNull();
  });
});
