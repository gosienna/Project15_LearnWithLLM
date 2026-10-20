import { loadBackendStatus, type BackendStatus } from "./llm/backend.ts";
import { Conversation, type StreamState } from "./llm/turn.ts";
import { createEmptyTopic, createRepository, openDatabase, type TopicRepository } from "./storage/db.ts";
import type { TopicRecord } from "./types.ts";
import { renderDialogue, type DialogueView } from "./ui/dialogue.ts";
import { renderShell, setTopicsOpen, type Shell } from "./ui/shell.ts";
import { renderTopics } from "./ui/topics.ts";
import { renderWhiteboard } from "./ui/whiteboard.ts";
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

function paint(app: AppController): void {
  const topic = activeTopic(app);
  renderTopics(app.shell.topics, app.topics, app.activeId, {
    onCreate: () => void createTopic(app),
    onSelect: (id) => void selectTopic(app, id),
    onDelete: (id) => void deleteTopic(app, id),
  });
  renderWhiteboard(app.shell.board, topic?.documentMarkdown ?? "");
  app.dialogue.renderTranscript(
    topic?.messages ?? [],
    app.stream && app.stream.topicId === app.activeId ? app.stream.state : null,
  );
  app.dialogue.setError(app.error);
  app.dialogue.setBusy(app.busy);
  app.dialogue.setComposerEnabled(app.status.composerEnabled);
  app.dialogue.setStatus(app.status.header, app.status.detail);
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
  app.status = await loadBackendStatus(window);
  app.dialogue.setStatus(app.status.header, app.status.detail);
  app.dialogue.setComposerEnabled(app.status.composerEnabled);
}

export async function boot(root: HTMLElement): Promise<void> {
  const shell = renderShell(root);
  const dialogue = renderDialogue(shell.dialogue, {
    onSend: (text) => void app.conversation.send(app.activeId, text),
    onStop: () => app.conversation.stop(),
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
      header: "Local LLM",
      detail: "Checking the local model…",
      composerEnabled: false,
      model: null,
    },
    conversation: undefined as unknown as Conversation,
  };

  app.conversation = new Conversation({
    repo,
    languageModel: () => app.status.model,
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
