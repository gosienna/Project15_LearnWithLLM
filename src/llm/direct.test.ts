import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendWindow } from "./backend.ts";
import { loadBackendStatus } from "./backend.ts";
import {
  DIRECT_STORAGE_KEY,
  createDirectLanguageModel,
  directModelId,
  directModelInfo,
  readDirectConfig,
  writeDirectConfig,
  type DirectConfig,
} from "./direct.ts";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const openai: DirectConfig = { provider: "openai", apiKey: "sk-test", model: "test-model", remember: false };

function page(): BackendWindow {
  return { addEventListener() {}, removeEventListener() {} };
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("direct config storage", () => {
  it("keeps an unremembered key for this tab only", () => {
    const stores = { local: memory(), session: memory() };
    writeDirectConfig(openai, stores);
    expect(stores.local.getItem(DIRECT_STORAGE_KEY)).toBeNull();
    expect(readDirectConfig(stores)).toEqual(openai);
  });

  it("remembers a key in localStorage and forgets it everywhere", () => {
    const stores = { local: memory(), session: memory() };
    writeDirectConfig({ ...openai, remember: true }, stores);
    expect(stores.session.getItem(DIRECT_STORAGE_KEY)).toBeNull();
    expect(readDirectConfig(stores)?.remember).toBe(true);
    writeDirectConfig(null, stores);
    expect(readDirectConfig(stores)).toBeNull();
  });

  it("lists nothing until the model is typed", () => {
    expect(directModelInfo({ ...openai, model: " " })).toBeNull();
    expect(directModelInfo({ ...openai, provider: "custom" })).toBeNull();
    expect(directModelInfo(openai)?.id).toBe(directModelId(openai));
  });
});

describe("loadBackendStatus with a typed-in key", () => {
  it("uses the key when there is no extension", async () => {
    const status = await loadBackendStatus(page(), null, openai);
    expect(status.composerEnabled).toBe(true);
    expect(status.chosen?.id).toBe(directModelId(openai));
    expect(status.model).not.toBeNull();
  });

  it("stays on the extension unless the key is chosen", async () => {
    const extension = { availability: async () => "available" as const, create: async () => ({}) as never };
    const win = { ...page(), LanguageModel: extension };
    expect((await loadBackendStatus(win, null, openai)).model).toBe(extension);
    const chosen = await loadBackendStatus(win, directModelId(openai), openai);
    expect(chosen.model).not.toBe(extension);
    expect(chosen.models.map((model) => model.id)).toContain(directModelId(openai));
  });
});

describe("OpenAI-compatible session", () => {
  it("runs tool calls and streams the final text", async () => {
    const bodies: { messages: { role: string }[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"x":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
        ]);
      }
      return sse([{ choices: [{ delta: { content: "Done" } }] }, { choices: [{ delta: { content: "." }, finish_reason: "stop" }] }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn(async (input: unknown) => ({ got: input }));
    const session = await createDirectLanguageModel(openai).create({
      initialPrompts: [{ role: "system", content: "Be brief." }],
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, execute }],
    });
    let text = "";
    for await (const chunk of session.promptStreaming("Hi") as AsyncIterable<string>) text += chunk;
    expect(text).toBe("Done.");
    expect(execute).toHaveBeenCalledWith({ x: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(bodies[1]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("names a rejected key NotAllowedError", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const session = await createDirectLanguageModel(openai).create({});
    const run = async () => {
      for await (const _ of session.promptStreaming("Hi") as AsyncIterable<string>) void _;
    };
    await expect(run()).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
