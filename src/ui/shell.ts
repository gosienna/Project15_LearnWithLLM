import type { UiMode } from "./mode.ts";

export interface Shell {
  app: HTMLElement;
  topics: HTMLElement;
  topicsToggle: HTMLButtonElement;
  systemButton: HTMLButtonElement;
  storeMaterial: HTMLButtonElement;
  modeButtons: Record<UiMode, HTMLButtonElement>;
  boardTabs: HTMLElement;
  board: HTMLElement;
  sources: HTMLElement;
  dialogue: HTMLElement;
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
  toolbarStart.append(topicsToggle, systemButton);
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
    clean: modeButton("clean", "Clean", "Only the lesson and the conversation"),
    debug: modeButton("debug", "Debug", "Every step of each turn and the raw whiteboard (Ctrl+Shift+D)"),
  };
  modeSwitch.append(modeButtons.clean, modeButtons.debug);

  const toolbarEnd = document.createElement("div");
  toolbarEnd.className = "toolbar-end";
  toolbarEnd.append(modeSwitch, storeMaterial);
  toolbar.append(toolbarStart, toolbarEnd);

  const boardTabs = document.createElement("div");
  boardTabs.className = "board-tabs";
  boardTabs.setAttribute("role", "tablist");
  boardTabs.setAttribute("aria-label", "Whiteboard sources");

  const board = document.createElement("article");
  board.className = "board";
  board.setAttribute("aria-label", "Whiteboard");

  const sources = document.createElement("section");
  sources.className = "board-sources";
  sources.setAttribute("role", "tabpanel");
  sources.hidden = true;

  const dialogue = document.createElement("section");
  dialogue.className = "dialogue";
  dialogue.setAttribute("aria-label", "Dialogue");

  stage.append(toolbar, boardTabs, board, sources);
  app.append(topics, stage, dialogue);
  root.append(app);

  topicsToggle.addEventListener("click", () => {
    const open = topics.classList.toggle("is-open");
    topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  return { app, topics, topicsToggle, systemButton, storeMaterial, modeButtons, boardTabs, board, sources, dialogue };
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
