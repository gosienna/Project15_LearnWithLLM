import { loadBackendStatus, readSavedModelId, writeSavedModelId, type BackendStatus } from "./llm/backend.ts";
import { Conversation, type StreamState } from "./llm/turn.ts";
import { createEmptyTopic, createRepository, openDatabase, type TopicRepository } from "./storage/db.ts";
import type { TopicRecord } from "./types.ts";
import { renderDialogue, type DialogueView } from "./ui/dialogue.ts";
import { renderSystemPanel } from "./ui/system.ts";
import { renderShell, setTopicsOpen, type Shell } from "./ui/shell.ts";
import { renderTopics } from "./ui/topics.ts";
import { boardIsEmpty, renderWhiteboard } from "./ui/whiteboard.ts";
import "./styles.css";

interface AppController {
  repo: TopicRepository;
  shell: Shell;
  dialogue: DialogueView;
  topics: TopicRecord[];
  activeId: string;
  stream: { topicId: string; state: StreamState } | null;
  error: string | null;
  busy: boolean;
  status: BackendStatus;
  conversation: Conversation;
}

function activeTopic(app: AppController): TopicRecord | undefined {
  return app.topics.find((topic) => topic.id === app.activeId);
}

export const STORE_MATERIAL_PROMPT =
  "Store the current whiteboard as the learning material. Write a markdown document of what the page teaches and call whiteboard_store_material. Do not change the html, css, js, svg, or json.";

function syncStoreButton(app: AppController): void {
  const topic = activeTopic(app);
  const empty = !topic || boardIsEmpty(topic);
  app.shell.storeMaterial.disabled = app.busy || empty;
}

function paint(app: AppController): void {
  const topic = activeTopic(app);
  renderTopics(app.shell.topics, app.topics, app.activeId, {
    onCreate: () => void createTopic(app),
    onSelect: (id) => void selectTopic(app, id),
    onDelete: (id) => void deleteTopic(app, id),
  });
  renderWhiteboard(app.shell.board, {
    html: topic?.html ?? "",
    css: topic?.css ?? "",
    js: topic?.js ?? "",
    svg: topic?.svg ?? "",
    json: topic?.json ?? "",
  });
  app.dialogue.renderTranscript(
    topic?.messages ?? [],
    app.stream && app.stream.topicId === app.activeId ? app.stream.state : null,
  );
  app.dialogue.setError(app.error);
  app.dialogue.setBusy(app.busy);
  app.dialogue.setComposerEnabled(app.status.composerEnabled);
  app.dialogue.setStatus(app.status.header, app.status.detail);
  syncStoreButton(app);
}

function upsert(app: AppController, topic: TopicRecord): void {
  const index = app.topics.findIndex((item) => item.id === topic.id);
  if (index === -1) app.topics.push(topic);
  else app.topics[index] = topic;
  app.topics.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

async function createTopic(app: AppController): Promise<void> {
  app.conversation.cancelForSwitch();
  app.stream = null;
  app.error = null;
  const topic = createEmptyTopic();
  await app.repo.put(topic);
  upsert(app, topic);
  app.activeId = topic.id;
  setTopicsOpen(app.shell, false);
  paint(app);
  app.dialogue.focus();
}

async function selectTopic(app: AppController, id: string): Promise<void> {
  if (id === app.activeId) {
    setTopicsOpen(app.shell, false);
    return;
  }
  app.conversation.cancelForSwitch();
  app.stream = null;
  app.error = null;
  app.busy = false;
  app.activeId = id;
  const topic = await app.repo.get(id);
  if (topic) upsert(app, topic);
  setTopicsOpen(app.shell, false);
  paint(app);
}

async function deleteTopic(app: AppController, id: string): Promise<void> {
  const topic = app.topics.find((item) => item.id === id);
  const title = topic?.title || "New topic";
  if (!window.confirm(`Delete “${title}”?`)) return;
  const deletingActive = id === app.activeId;
  if (deletingActive) {
    app.conversation.cancelForSwitch();
    app.stream = null;
    app.error = null;
    app.busy = false;
  }
  await app.repo.delete(id);
  app.topics = app.topics.filter((item) => item.id !== id);
  if (!deletingActive) {
    paint(app);
    return;
  }
  const next = app.topics[0] ?? null;
  if (next) {
    app.activeId = next.id;
  } else {
    const created = createEmptyTopic();
    await app.repo.put(created);
    app.topics = [created];
    app.activeId = created.id;
  }
  paint(app);
}

async function refreshStatus(app: AppController): Promise<void> {
  app.status = await loadBackendStatus(window, readSavedModelId());
  app.dialogue.setStatus(app.status.header, app.status.detail);
  app.dialogue.setComposerEnabled(app.status.composerEnabled);
  syncStoreButton(app);
}

export async function boot(root: HTMLElement): Promise<void> {
  const shell = renderShell(root);
  const dialogue = renderDialogue(shell.dialogue, {
    onSend: (text) => void app.conversation.send(app.activeId, text),
    onStop: () => app.conversation.stop(),
  });
  shell.storeMaterial.addEventListener("click", () => {
    void app.conversation.send(app.activeId, STORE_MATERIAL_PROMPT);
  });
  const system = renderSystemPanel((id) => {
    const previous = app.status.chosen?.id ?? null;
    writeSavedModelId(id);
    if (id !== previous) app.conversation.destroySession();
    void refreshStatus(app);
  });
  shell.systemButton.addEventListener("click", () => {
    void refreshStatus(app).then(() => {
      system.open(app.status.models, app.status.chosen?.id ?? null, app.status.modelNote);
    });
  });

  let app: AppController;
  const repo = createRepository(await openDatabase());
  const topics = await repo.list();
  let active = topics[0];
  if (!active) {
    active = createEmptyTopic();
    await repo.put(active);
    topics.push(active);
  }

  app = {
    repo,
    shell,
    dialogue,
    topics,
    activeId: active.id,
    stream: null,
    error: null,
    busy: false,
    status: {
      header: "Language model",
      detail: "Checking the model…",
      composerEnabled: false,
      model: null,
      models: [],
      modelNote: null,
      chosen: null,
    },
    conversation: undefined as unknown as Conversation,
  };

  app.conversation = new Conversation({
    repo,
    languageModel: () => app.status.model,
    modelId: () => app.status.chosen?.id ?? null,
    contextTokens: () => app.status.chosen?.inputQuota,
    getOpenTopicId: () => app.activeId,
    onTopic: (topic) => {
      upsert(app, topic);
      paint(app);
    },
    onStream: (topicId, state) => {
      app.stream = state ? { topicId, state } : null;
      paint(app);
    },
    onError: (message) => {
      app.error = message;
      dialogue.setError(message);
    },
    onBusy: (busy) => {
      app.busy = busy;
      dialogue.setBusy(busy);
      syncStoreButton(app);
    },
    onDownload: (ratio) => {
      if (ratio === null) return;
      app.status = { ...app.status, detail: `Downloading ${Math.round(ratio * 100)}%` };
      dialogue.setStatus(app.status.header, app.status.detail);
    },
  });

  paint(app);
  await refreshStatus(app);
  window.addEventListener("focus", () => void refreshStatus(app));
}

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  void boot(root).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Could not open the lesson store.";
    root.textContent = message;
  });
}
