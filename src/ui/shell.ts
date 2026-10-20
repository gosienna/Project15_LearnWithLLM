export interface Shell {
  app: HTMLElement;
  topics: HTMLElement;
  topicsToggle: HTMLButtonElement;
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
  const topicsToggle = document.createElement("button");
  topicsToggle.type = "button";
  topicsToggle.className = "topics-toggle";
  topicsToggle.textContent = "Topics";
  topicsToggle.setAttribute("aria-expanded", "false");
  toolbar.append(topicsToggle);

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

  return { app, topics, topicsToggle, board, dialogue };
}

export function setTopicsOpen(shell: Shell, open: boolean): void {
  shell.topics.classList.toggle("is-open", open);
  shell.topicsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
