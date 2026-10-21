import type { UiMode } from "./mode.ts";

export interface Shell {
  app: HTMLElement;
  topics: HTMLElement;
  topicsToggle: HTMLButtonElement;
  systemButton: HTMLButtonElement;
  storeMaterial: HTMLButtonElement;
  modeButtons: Record<UiMode, HTMLButtonElement>;
  stop: HTMLButtonElement;
  modelName: HTMLElement;
  modelStatus: HTMLElement;
  error: HTMLElement;
  boardTabs: HTMLElement;
  /** Holds the board and the question panel over it; hidden while another debug tab is open. */
  boardArea: HTMLElement;
  board: HTMLElement;
  sources: HTMLElement;
}

export function renderShell(root: HTMLElement): Shell {
  root.replaceChildren();
  const app = document.createElement("div");
  app.className = "app";

  const topics = document.createElement("aside");
  topics.className = "topics";
  topics.setAttribute("aria-label", "Topics");

  const stage = document.createElement("div");
  stage.className = "stage";

  const toolbar = document.createElement("div");
  toolbar.className = "board-toolbar";
  const toolbarStart = document.createElement("div");
  toolbarStart.className = "toolbar-start";
  const topicsToggle = document.createElement("button");
  topicsToggle.type = "button";
  topicsToggle.className = "topics-toggle";
  topicsToggle.textContent = "Topics";
  topicsToggle.setAttribute("aria-expanded", "false");
  const systemButton = document.createElement("button");
  systemButton.type = "button";
  systemButton.className = "system-open";
  systemButton.textContent = "System";
  const modelChip = document.createElement("div");
  modelChip.className = "model-chip";
  const modelName = document.createElement("p");
  modelName.className = "model-name";
  const modelStatus = document.createElement("p");
  modelStatus.className = "model-status";
  modelChip.append(modelName, modelStatus);
  toolbarStart.append(topicsToggle, systemButton, modelChip);
  const storeMaterial = document.createElement("button");
  storeMaterial.type = "button";
  storeMaterial.className = "store-material";
  storeMaterial.textContent = "Store learning material";
  storeMaterial.disabled = true;

  const modeSwitch = document.createElement("div");
  modeSwitch.className = "mode-switch";
  modeSwitch.setAttribute("role", "group");
  modeSwitch.setAttribute("aria-label", "View mode");
  const modeButton = (mode: UiMode, label: string, hint: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-option";
    button.dataset.mode = mode;
    button.textContent = label;
    button.title = hint;
    button.setAttribute("aria-pressed", "false");
    return button;
  };
  const modeButtons: Record<UiMode, HTMLButtonElement> = {
    clean: modeButton("clean", "Clean", "Only the lesson"),
    debug: modeButton("debug", "Debug", "Every step of each ask and the raw whiteboard (Ctrl+Shift+D)"),
  };
  modeSwitch.append(modeButtons.clean, modeButtons.debug);

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "stop";
  stop.textContent = "Stop";
  stop.hidden = true;

  const toolbarEnd = document.createElement("div");
  toolbarEnd.className = "toolbar-end";
  toolbarEnd.append(stop, modeSwitch, storeMaterial);
  toolbar.append(toolbarStart, toolbarEnd);

  const boardTabs = document.createElement("div");
  boardTabs.className = "board-tabs";
  boardTabs.setAttribute("role", "tablist");
  boardTabs.setAttribute("aria-label", "Whiteboard sources");

  const error = document.createElement("p");
  error.className = "board-error";
  error.setAttribute("role", "status");
  error.hidden = true;

  const boardArea = document.createElement("div");
  boardArea.className = "board-area";
  const board = document.createElement("article");
  board.className = "board";
  board.setAttribute("aria-label", "Whiteboard");
  boardArea.append(board);

  const sources = document.createElement("section");
  sources.className = "board-sources";
  sources.setAttribute("role", "tabpanel");
  sources.hidden = true;

  stage.append(toolbar, boardTabs, error, boardArea, sources);
  app.append(topics, stage);
  root.append(app);

  topicsToggle.addEventListener("click", () => {
    const open = topics.classList.toggle("is-open");
    topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  return {
    app,
    topics,
    topicsToggle,
    systemButton,
    storeMaterial,
    modeButtons,
    stop,
    modelName,
    modelStatus,
    error,
    boardTabs,
    boardArea,
    board,
    sources,
  };
}

export function applyMode(shell: Shell, mode: UiMode): void {
  shell.app.dataset.mode = mode;
  for (const [key, button] of Object.entries(shell.modeButtons)) {
    button.setAttribute("aria-pressed", key === mode ? "true" : "false");
  }
}

export function setTopicsOpen(shell: Shell, open: boolean): void {
  shell.topics.classList.toggle("is-open", open);
  shell.topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
