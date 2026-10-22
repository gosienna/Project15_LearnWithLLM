import { fetchImageAvailable, loadBackendStatus, readSavedModelId, searchAvailable, writeSavedModelId, type BackendStatus, type BackendWindow } from "./llm/backend.ts";
import { toolSpecs } from "./llm/tools.ts";
import { Tutor } from "./llm/turn.ts";
import { boardImageSources } from "./storage/board-images.ts";
import { createEmptyTopic, createRepository, openDatabase, type TopicRepository } from "./storage/db.ts";
import type { BoardSources, FetchImageFn, SearchFn, SelectionAnchor, TopicRecord, TurnTrace } from "./types.ts";
import { renderAskPopover, type AskPopover } from "./ui/ask-popover.ts";
import { renderExplainPopover, type ExplainPopover } from "./ui/explain-popover.ts";
import { createProgressView, progressLine, type ProgressView } from "./ui/progress-view.ts";
import { renderSystemPanel } from "./ui/system.ts";
import { readMode, writeMode, type UiMode } from "./ui/mode.ts";
import { applyMode, renderShell, setTopicsOpen, type Shell } from "./ui/shell.ts";
import { readWebSearch, writeWebSearch } from "./ui/web-search.ts";
import { renderSources, type PromptInputs } from "./ui/sources.ts";
import { renderTopics } from "./ui/topics.ts";
import {
  boardDraft,
  boardIsEmpty,
  clearBoardHighlight,
  focusStart,
  renderWhiteboard,
  syncStartForm,
  type BoardImageSources,
} from "./ui/whiteboard.ts";
import "./styles.css";

interface AppController {
  repo: TopicRepository;
  shell: Shell;
  popover: AskPopover;
  /** The model's floating explanation from the last ask. Cleared when the next ask starts. */
  explain: ExplainPopover;
  progress: ProgressView;
  topics: TopicRecord[];
  activeId: string;
  error: string | null;
  busy: boolean;
  status: BackendStatus;
  tutor: Tutor;
  mode: UiMode;
  /** The learner's Web search switch. */
  webSearch: boolean;
  /** This visit's asks on the open topic, newest first. Never saved. */
  traces: TurnTrace[];
  liveTraceId: string | null;
  /** Listeners for the Next request tab: the question or the selection changed. */
  draftListeners: Set<() => void>;
  /** The open topic's images as the board shows them, once read; painting starts from these. */
  imageSources: { topicId: string; map: BoardImageSources } | null;
}

function activeTopic(app: AppController): TopicRecord | undefined {
  return app.topics.find((topic) => topic.id === app.activeId);
}

export const STORE_MATERIAL_PROMPT =
  "Store the current whiteboard as the learning material. Write a markdown document of what the page teaches and call whiteboard_store_material. Do not change the html, css, js, svg, or json.";

/** localLLM.search, when the switch is on and the extension offers it. */
function activeSearch(app: AppController): SearchFn | null {
  const win = window as unknown as BackendWindow;
  if (!app.webSearch || !searchAvailable(win)) return null;
  return (query, maxResults, includeImages) => win.localLLM!.search!(query, { maxResults, includeImages });
}

/** localLLM.fetchImage, when web search is on and the extension offers it. */
function activeFetchImage(app: AppController): FetchImageFn | null {
  const win = window as unknown as BackendWindow;
  if (!activeSearch(app) || !fetchImageAvailable(win)) return null;
  return async (url) => (await win.localLLM!.fetchImage!(url)).blob;
}

function syncControls(app: AppController): void {
  const topic = activeTopic(app);
  const empty = !topic || boardIsEmpty(topic);
  const ready = app.status.composerEnabled;
  app.shell.storeMaterial.disabled = app.busy || empty || !ready;
  app.shell.stop.hidden = !app.busy;
  const canSearch = searchAvailable(window as unknown as BackendWindow);
  app.shell.webSearch.disabled = !canSearch;
  app.shell.webSearch.setAttribute("aria-pressed", app.webSearch && canSearch ? "true" : "false");
  app.shell.webSearch.title = canSearch
    ? "Let the model search the web. The extension must also allow web search for this site (options → Sites)."
    : "This extension has no web search. Update it, then reload this page.";
  app.shell.modelName.textContent = app.status.header;
  app.shell.modelStatus.textContent = app.status.detail;
  app.shell.error.hidden = !app.error;
  app.shell.error.textContent = app.error ?? "";
  syncStartForm(app.shell.board, { enabled: ready, busy: app.busy });
  app.popover.setEnabled(ready);
  app.popover.setBusy(app.busy);
}

function notifyDraft(app: AppController): void {
  for (const listener of app.draftListeners) listener();
}

/** The question the next ask sends: the open panel's, or the start form's on an empty board. */
function pendingQuestion(app: AppController): string {
  return app.popover.isOpen() ? app.popover.question() : boardDraft(app.shell.board);
}

function paint(app: AppController): void {
  const topic = activeTopic(app);
  renderTopics(app.shell.topics, app.topics, app.activeId, {
    onCreate: () => void createTopic(app),
    onSelect: (id) => void selectTopic(app, id),
    onDelete: (id) => void deleteTopic(app, id),
  });
  const sources = {
    html: topic?.html ?? "",
    css: topic?.css ?? "",
    js: topic?.js ?? "",
    svg: topic?.svg ?? "",
    json: topic?.json ?? "",
  };
  paintBoard(app, topic, sources);
  renderSources(
    { tabs: app.shell.boardTabs, board: app.shell.boardArea, pane: app.shell.sources },
    { ...sources, material: topic?.materialMarkdown ?? "", images: topic?.images ?? [] },
    app.mode,
    topic ? promptInputs(app, topic) : undefined,
  );
  placeProgress(app);
  syncControls(app);
}

/**
 * Draw the board with the images read so far (a new one shows from its url), then again once every
 * cached copy is a data: URL. renderWhiteboard skips the second draw when nothing changed.
 */
function paintBoard(app: AppController, topic: TopicRecord | undefined, sources: BoardSources): void {
  const handlers = {
    onStart: (question: string) => void ask(app, question, null),
    onSelection: (anchor: SelectionAnchor | null) => onSelection(app, anchor),
    onDraft: () => notifyDraft(app),
  };
  const images = topic?.images ?? [];
  const known = topic && app.imageSources?.topicId === topic.id ? app.imageSources.map : {};
  const first: BoardImageSources = {};
  for (const image of images) first[image.id] = known[image.id] ?? image.url;
  renderWhiteboard(app.shell.board, sources, handlers, first);
  if (!topic || images.length === 0) return;
  void boardImageSources(topic.id, images).then((map) => {
    if (app.activeId !== topic.id || activeTopic(app)?.images !== images) return;
    app.imageSources = { topicId: topic.id, map };
    renderWhiteboard(app.shell.board, sources, handlers, map);
  });
}

/** Under the start form while the first lesson is written; otherwise floating over the board. */
function placeProgress(app: AppController): void {
  const form = app.shell.board.querySelector(".board-start");
  const target = form ?? app.shell.boardArea;
  const element = app.progress.element;
  if (element.parentElement !== target) target.append(element);
  element.classList.toggle("is-floating", !form);
}

function onSelection(app: AppController, anchor: SelectionAnchor | null): void {
  if (anchor) {
    app.popover.show(anchor);
    return;
  }
  // A click elsewhere on the board closes an empty panel and keeps a typed question.
  if (!app.popover.question().trim()) app.popover.hide();
}

async function ask(app: AppController, question: string, anchor: SelectionAnchor | null): Promise<void> {
  if (anchor) app.popover.setStatus("Starting the model…");
  await app.tutor.ask(app.activeId, question, { anchor });
  if (!anchor) return;
  if (app.error) {
    app.popover.setStatus(app.error);
    return;
  }
  app.popover.hide();
  clearBoardHighlight(app.shell.board);
}

function promptInputs(app: AppController, topic: TopicRecord): PromptInputs {
  return {
    topicId: topic.id,
    system: () => app.tutor.previewSystem(topic),
    request: () => ({ ...app.tutor.previewRequest(topic), tools: toolSpecs(activeSearch(app) !== null, activeFetchImage(app) !== null) }),
    prompt: () => app.tutor.previewPrompt(topic, pendingQuestion(app), app.popover.anchor()),
    selection: () => app.popover.anchor(),
    subscribePrompt: (listener) => {
      app.draftListeners.add(listener);
      return () => app.draftListeners.delete(listener);
    },
    traces: () => app.traces,
    liveTraceId: () => app.liveTraceId,
    onPinSystem: (text) => void pinSystemPrompt(app, topic.id, text),
    onUnpinSystem: () => void pinSystemPrompt(app, topic.id, undefined),
    onSetRequest: (prompts) => {
      app.tutor.setNextRequest(topic.id, prompts);
      paint(app);
    },
  };
}

async function pinSystemPrompt(app: AppController, topicId: string, text: string | undefined): Promise<void> {
  const topic = await app.repo.get(topicId);
  if (!topic) return;
  if (text === undefined) delete topic.systemPrompt;
  else topic.systemPrompt = text;
  topic.updatedAt = Date.now();
  await app.repo.put(topic);
  upsert(app, topic);
  paint(app);
}

function setMode(app: AppController, mode: UiMode): void {
  if (mode === app.mode) return;
  app.mode = mode;
  writeMode(mode);
  applyMode(app.shell, mode);
  paint(app);
}

function upsert(app: AppController, topic: TopicRecord): void {
  const index = app.topics.findIndex((item) => item.id === topic.id);
  if (index === -1) app.topics.push(topic);
  else app.topics[index] = topic;
  app.topics.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/** Leave the open topic: stop its ask and forget this visit's selection and traces. */
function leaveTopic(app: AppController): void {
  app.tutor.cancelForSwitch();
  app.error = null;
  app.busy = false;
  app.traces = [];
  app.liveTraceId = null;
  app.progress.update(null);
  app.popover.hide();
  app.explain.hide();
}

async function createTopic(app: AppController): Promise<void> {
  leaveTopic(app);
  const topic = createEmptyTopic();
  await app.repo.put(topic);
  upsert(app, topic);
  app.activeId = topic.id;
  setTopicsOpen(app.shell, false);
  paint(app);
  focusStart(app.shell.board);
}

async function selectTopic(app: AppController, id: string): Promise<void> {
  if (id === app.activeId) {
    setTopicsOpen(app.shell, false);
    return;
  }
  leaveTopic(app);
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
  if (deletingActive) leaveTopic(app);
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

/** The extension closes its connection after 25s idle and fires `localllm:closed`; the next call reopens it. */
export const SERVICE_CLOSED = "Model service closed after being idle. Your next ask restarts it.";
export const SERVICE_UNRESPONSIVE = "The model service stopped answering. Reload the page.";

async function refreshStatus(app: AppController): Promise<void> {
  app.status = await loadBackendStatus(window, readSavedModelId());
  syncControls(app);
}

export async function boot(root: HTMLElement): Promise<void> {
  const shell = renderShell(root);
  let app: AppController;
  const popover = renderAskPopover(shell.boardArea, {
    onAsk: (question, anchor) => void ask(app, question, anchor),
    onCancel: () => clearBoardHighlight(shell.board),
    onStop: () => app.tutor.stop(),
    onInput: () => notifyDraft(app),
  });
  const explain = renderExplainPopover(shell.boardArea);
  shell.storeMaterial.addEventListener("click", () => {
    void app.tutor.ask(app.activeId, STORE_MATERIAL_PROMPT, { note: false });
  });
  shell.stop.addEventListener("click", () => app.tutor.stop());
  const system = renderSystemPanel((id) => {
    writeSavedModelId(id);
    void refreshStatus(app);
  });
  shell.systemButton.addEventListener("click", () => {
    void refreshStatus(app).then(() => {
      system.open(app.status.models, app.status.chosen?.id ?? null, app.status.modelNote);
    });
  });

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
    popover,
    explain,
    progress: createProgressView(),
    topics,
    activeId: active.id,
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
    tutor: undefined as unknown as Tutor,
    mode: readMode(),
    webSearch: readWebSearch(),
    traces: [],
    liveTraceId: null,
    draftListeners: new Set(),
    imageSources: null,
  };
  applyMode(shell, app.mode);
  shell.webSearch.addEventListener("click", () => {
    app.webSearch = !app.webSearch;
    writeWebSearch(app.webSearch);
    syncControls(app);
    paint(app);
  });
  shell.modeButtons.clean.addEventListener("click", () => setMode(app, "clean"));
  shell.modeButtons.debug.addEventListener("click", () => setMode(app, "debug"));
  window.addEventListener("keydown", (event) => {
    // Ctrl, not Cmd: Cmd+Shift+D is the browser's "bookmark all tabs" on macOS.
    if (!event.ctrlKey || event.metaKey || !event.shiftKey || event.key.toLowerCase() !== "d") return;
    event.preventDefault();
    setMode(app, app.mode === "debug" ? "clean" : "debug");
  });

  app.tutor = new Tutor({
    repo,
    languageModel: () => app.status.model,
    modelId: () => app.status.chosen?.id ?? null,
    search: () => activeSearch(app),
    fetchImage: () => activeFetchImage(app),
    contextTokens: () => app.status.chosen?.inputQuota,
    getOpenTopicId: () => app.activeId,
    onTopic: (topic) => {
      upsert(app, topic);
      paint(app);
    },
    onTrace: (topicId, trace, done) => {
      if (topicId !== app.activeId) return;
      if (!app.traces.includes(trace)) app.traces.unshift(trace);
      app.liveTraceId = done ? null : trace.id ?? null;
      app.progress.update(done ? null : trace);
      if (!done && trace.selection && app.popover.isOpen()) app.popover.setStatus(progressLine(trace));
      if (app.mode === "debug") paint(app);
    },
    onError: (message) => {
      app.error = message;
      syncControls(app);
    },
    onExplain: (topicId, { text, anchor }) => {
      if (topicId === app.activeId) app.explain.show(text, anchor);
    },
    onBusy: (busy) => {
      // A new ask starts: the last answer's explanation goes away.
      if (busy) app.explain.hide();
      app.busy = busy;
      syncControls(app);
      if (busy && app.status.detail === SERVICE_CLOSED) void refreshStatus(app);
    },
    onDownload: (ratio) => {
      if (ratio === null) return;
      // Chrome reports 0 and 1 even for a model already on disk; only a real download is shown.
      if (ratio >= 1) {
        void refreshStatus(app);
        return;
      }
      if (ratio <= 0) return;
      app.status = { ...app.status, detail: `Downloading ${Math.round(ratio * 100)}%` };
      syncControls(app);
    },
  });

  paint(app);
  focusStart(shell.board);
  await refreshStatus(app);
  window.addEventListener("focus", () => void refreshStatus(app));
  window.addEventListener("localllm:closed", (event) => {
    const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
    app.status = { ...app.status, detail: reason === "unresponsive" ? SERVICE_UNRESPONSIVE : SERVICE_CLOSED };
    syncControls(app);
  });
}

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  void boot(root).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Could not open the lesson store.";
    root.textContent = message;
  });
}
