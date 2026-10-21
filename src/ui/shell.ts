export interface Shell {
  app: HTMLElement;
  topics: HTMLElement;
  topicsToggle: HTMLButtonElement;
  systemButton: HTMLButtonElement;
  storeMaterial: HTMLButtonElement;
  board: HTMLElement;
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
  toolbar.append(toolbarStart, storeMaterial);

  const board = document.createElement("article");
  board.className = "board";
  board.setAttribute("aria-label", "Whiteboard");

  const dialogue = document.createElement("section");
  dialogue.className = "dialogue";
  dialogue.setAttribute("aria-label", "Dialogue");

  stage.append(toolbar, board);
  app.append(topics, stage, dialogue);
  root.append(app);

  topicsToggle.addEventListener("click", () => {
    const open = topics.classList.toggle("is-open");
    topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  return { app, topics, topicsToggle, systemButton, storeMaterial, board, dialogue };
}

export function setTopicsOpen(shell: Shell, open: boolean): void {
  shell.topics.classList.toggle("is-open", open);
  shell.topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
