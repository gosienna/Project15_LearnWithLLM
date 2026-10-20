import type { TopicRecord } from "../types.ts";

export interface TopicHandlers {
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatUpdated(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
}

export function renderTopics(host: HTMLElement, topics: TopicRecord[], activeId: string, handlers: TopicHandlers): void {
  host.replaceChildren();

  const header = document.createElement("div");
  header.className = "topics-header";
  const label = document.createElement("p");
  label.className = "topics-label";
  label.textContent = "Topics";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "new-topic";
  create.textContent = "New topic";
  create.addEventListener("click", handlers.onCreate);
  header.append(label, create);

  const list = document.createElement("ul");
  list.className = "topic-list";
  for (const topic of topics) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "topic-row";
    if (topic.id === activeId) row.classList.add("is-active");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "topic-select";
    if (topic.id === activeId) select.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "topic-title";
    title.textContent = topic.title || "New topic";
    const when = document.createElement("span");
    when.className = "topic-date";
    when.textContent = formatUpdated(topic.updatedAt);
    select.append(title, when);
    select.addEventListener("click", () => handlers.onSelect(topic.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "topic-delete";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${topic.title || "New topic"}`);
    remove.addEventListener("click", () => handlers.onDelete(topic.id));

    row.append(select, remove);
    item.append(row);
    list.append(item);
  }

  host.append(header, list);
}
