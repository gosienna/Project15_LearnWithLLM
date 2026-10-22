import type { ModelInfo } from "../types.ts";
import { PROVIDERS, listDirectModels, type DirectConfig, type DirectProvider } from "../llm/direct.ts";
import { WEB_SEARCH_TOOL_SPEC, WHITEBOARD_TOOL_INFO } from "../llm/tools.ts";

export interface SystemPanel {
  open(models: ModelInfo[], chosenId: string | null, note?: string | null, direct?: DirectConfig | null): void;
}

export interface SystemHandlers {
  onChoose: (id: string) => void;
  /** Save the typed-in key and use it, or forget it (null). */
  onSaveKey: (config: DirectConfig | null) => void;
}

interface KeyForm {
  element: HTMLElement;
  fill(config: DirectConfig | null): void;
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "system-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

/** Provider, model, and key, sent from this browser to the provider. No extension needed. */
function renderKeyForm(onSave: (config: DirectConfig | null) => void): KeyForm {
  const form = document.createElement("form");
  form.className = "system-key";

  const intro = document.createElement("p");
  intro.className = "system-note";
  intro.textContent =
    "Use a model without the extension. The page sends your key straight to the provider; it is kept only in this browser.";

  const provider = document.createElement("select");
  for (const [id, preset] of Object.entries(PROVIDERS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.label;
    provider.append(option);
  }

  const baseUrl = document.createElement("input");
  baseUrl.type = "url";
  baseUrl.placeholder = "https://example.com/v1";
  baseUrl.autocomplete = "off";
  const baseUrlField = field("Base URL", baseUrl);

  const apiKey = document.createElement("input");
  apiKey.type = "password";
  apiKey.autocomplete = "off";
  apiKey.spellcheck = false;
  apiKey.required = true;

  const model = document.createElement("input");
  model.type = "text";
  model.autocomplete = "off";
  model.spellcheck = false;
  model.required = true;
  const suggestions = document.createElement("datalist");
  suggestions.id = "system-key-models";
  model.setAttribute("list", suggestions.id);
  const loadModels = document.createElement("button");
  loadModels.type = "button";
  loadModels.className = "system-small";
  loadModels.textContent = "List models";
  const modelRow = document.createElement("div");
  modelRow.className = "system-row";
  modelRow.append(model, loadModels, suggestions);

  const remember = document.createElement("input");
  remember.type = "checkbox";
  const rememberLabel = document.createElement("label");
  rememberLabel.className = "system-check";
  rememberLabel.append(remember, document.createTextNode(" Remember the key after this tab closes"));

  const status = document.createElement("p");
  status.className = "system-note";
  status.setAttribute("role", "status");

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "system-primary";
  save.textContent = "Use this key";
  const forget = document.createElement("button");
  forget.type = "button";
  forget.className = "system-small";
  forget.textContent = "Forget key";
  const actions = document.createElement("div");
  actions.className = "system-row";
  actions.append(save, forget);

  const current = (): DirectProvider => provider.value as DirectProvider;
  const syncProvider = (resetModel: boolean) => {
    const preset = PROVIDERS[current()];
    baseUrlField.hidden = current() !== "custom";
    baseUrl.required = current() === "custom";
    apiKey.placeholder = preset.keyHint;
    model.placeholder = preset.defaultModel || "model id";
    if (resetModel) {
      model.value = preset.defaultModel;
      suggestions.replaceChildren();
    }
  };
  provider.addEventListener("change", () => syncProvider(true));

  loadModels.addEventListener("click", () => {
    if (!apiKey.value.trim()) {
      status.textContent = "Type the API key first.";
      return;
    }
    status.textContent = "Listing models…";
    void listDirectModels({ provider: current(), apiKey: apiKey.value.trim(), baseUrl: baseUrl.value.trim() }).then(
      (ids) => {
        suggestions.replaceChildren(
          ...ids.map((id) => {
            const option = document.createElement("option");
            option.value = id;
            return option;
          }),
        );
        status.textContent = ids.length ? `${ids.length} models. Pick one in the model field.` : "The provider listed no models.";
      },
      (error: unknown) => {
        status.textContent = error instanceof Error ? error.message : "Could not list models.";
      },
    );
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const config: DirectConfig = {
      provider: current(),
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
      remember: remember.checked,
      ...(current() === "custom" ? { baseUrl: baseUrl.value.trim() } : {}),
    };
    status.textContent = `Using ${config.model}.`;
    onSave(config);
  });
  forget.addEventListener("click", () => {
    apiKey.value = "";
    status.textContent = "The key is forgotten.";
    onSave(null);
  });

  form.append(
    intro,
    field("Provider", provider),
    baseUrlField,
    field("API key", apiKey),
    field("Model", modelRow),
    rememberLabel,
    actions,
    status,
  );

  return {
    element: form,
    fill(config) {
      provider.value = config?.provider ?? "anthropic";
      syncProvider(!config);
      if (config) {
        apiKey.value = config.apiKey;
        model.value = config.model;
        baseUrl.value = config.baseUrl ?? "";
        remember.checked = config.remember;
      }
      forget.disabled = !config;
      status.textContent = "";
    },
  };
}

export function renderSystemPanel({ onChoose, onSaveKey }: SystemHandlers): SystemPanel {
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

  const keyTitle = document.createElement("h3");
  keyTitle.textContent = "Your API key";
  const keyForm = renderKeyForm(onSaveKey);

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

  dialog.append(head, modelsTitle, modelList, keyTitle, keyForm.element, toolsTitle, toolList);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  return {
    open(models, chosenId, note = null, direct = null) {
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
        if (note) {
          const extra = document.createElement("p");
          extra.className = "system-empty";
          extra.textContent = note;
          modelList.append(extra);
        }
      }
      if (!dialog.open) keyForm.fill(direct);
      if (!dialog.open) dialog.showModal();
    },
  };
}
