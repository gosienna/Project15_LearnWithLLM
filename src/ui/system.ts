import type { ModelInfo } from "../types.ts";
import { WEB_SEARCH_TOOL_SPEC, WHITEBOARD_TOOL_INFO } from "../llm/tools.ts";

export interface SystemPanel {
  open(models: ModelInfo[], chosenId: string | null, note?: string | null): void;
}

export function renderSystemPanel(onChoose: (id: string) => void): SystemPanel {
  const dialog = document.createElement("dialog");
  dialog.className = "system-dialog";
  dialog.setAttribute("aria-labelledby", "system-title");

  const heading = document.createElement("h2");
  heading.id = "system-title";
  heading.textContent = "System";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "system-close";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  const head = document.createElement("div");
  head.className = "system-head";
  head.append(heading, close);

  const modelsTitle = document.createElement("h3");
  modelsTitle.textContent = "Available models";
  const modelList = document.createElement("div");
  modelList.className = "system-models";

  const toolsTitle = document.createElement("h3");
  toolsTitle.textContent = "Tools for the model";
  const toolList = document.createElement("ul");
  toolList.className = "system-tools";
  const webSearchInfo = { name: WEB_SEARCH_TOOL_SPEC.name, description: `${WEB_SEARCH_TOOL_SPEC.description} Offered only while Web search is on.` };
  for (const tool of [...WHITEBOARD_TOOL_INFO, webSearchInfo]) {
    const item = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = tool.name;
    const text = document.createElement("span");
    text.textContent = tool.description;
    item.append(name, text);
    toolList.append(item);
  }

  dialog.append(head, modelsTitle, modelList, toolsTitle, toolList);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  return {
    open(models, chosenId, note = null) {
      modelList.replaceChildren();
      if (models.length === 0) {
        const empty = document.createElement("p");
        empty.className = "system-empty";
        empty.textContent = note || "No model is available for this site.";
        modelList.append(empty);
      } else {
        for (const model of models) {
          const label = document.createElement("label");
          label.className = "system-model";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = "system-model";
          input.value = model.id;
          input.checked = model.id === chosenId;
          input.addEventListener("change", () => {
            if (input.checked) onChoose(model.id);
          });
          const body = document.createElement("span");
          const title = document.createElement("strong");
          title.textContent = model.name;
          const meta = document.createElement("small");
          const bits = [model.provider, model.engine, model.tools === "native" ? "native tools" : "prompted tools"];
          if (model.default) bits.push("default");
          meta.textContent = bits.filter(Boolean).join(" · ");
          body.append(title, meta);
          label.append(input, body);
          modelList.append(label);
        }
      }
      if (!dialog.open) dialog.showModal();
    },
  };
}
