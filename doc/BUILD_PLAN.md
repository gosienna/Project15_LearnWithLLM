# Learn with LLM — Build Plan

Oct 20, 2026

A single-page web app. The learner types a question or a topic in a dialogue panel. The model, served by the already-installed [Project14 Chrome LLM backend](https://github.com/gosienna/Project14_ChromeLLMBackend), writes the lesson onto a whiteboard in the center of the page and keeps editing that lesson as the conversation continues. Each topic is stored in IndexedDB. The live board is html, css, js, svg, and json. A markdown document is stored only when the learner asks, and that document is what a later system message can include in full.

This document is the build plan. It does not ship the app.

## Backend this app codes against

Contract source: [Project14_ChromeLLMBackend](https://github.com/gosienna/Project14_ChromeLLMBackend), default branch `claude/bold-newton-214zj7` at `6d6be851dcc1379636f3729247a9aff8f486ad66`. The page-facing guide is the README section **Using the backend from a web app**.

The app does not bundle a model, an API key, or the extension. It calls the Prompt API the extension injects into approved pages:

```js
const session = await LanguageModel.create({
  initialPrompts: [{ role: "system", content: systemPrompt }],
  tools,
});
for await (const chunk of session.promptStreaming(userText, { signal })) {
  appendDialogue(chunk);
}
```

Facts from that contract that shape this app:

| Fact | What this app does with it |
| --- | --- |
| `window.LanguageModel` exists only after the user has enabled this origin. `window.localLLM` means the extension is the provider. | Treat the backend as already installed and available. Show one short blocked state if the page cannot see `LanguageModel`. |
| `create()` takes one system message, then user/assistant turns. The system message is fixed for the life of the session. | Put the whiteboard status in that system message, and the stored markdown when the learner has saved it. After a turn that changes a source or the stored markdown, destroy the session and create another one so the next turn sees the new state. |
| Tools are declared on `create()`. `execute()` runs in the page. The extension only sees the name, description, and input schema. At most 32 tools. Names match `/^[A-Za-z_][\w-]{0,63}$/`. | All whiteboard edits are page-side tools. They update the DOM and IndexedDB, then return a short result. |
| A prompt may run up to 8 tool rounds. Tool results count toward the context window. | `whiteboard_view` returns one source. The other tools return a short result. A request for every source returns lengths when the sources are long. |
| Default budget is 2 sessions per origin, 8192 context tokens, 20k tokens/minute. Oldest non-system turns are dropped when the session overflows. One prompt larger than the quota rejects with `QuotaExceededError`. | One live session. Fit the lesson first, then as much recent dialogue as remains. |
| `promptStreaming()` yields text deltas. Aborting drops that turn from the conversation. Tool `execute()` is not cancelled by the prompt signal. | Stream into the dialogue. Persist each successful tool write immediately, even if the user stops the reply. |
| Local models that lack native tool calling use prompted tool calling. Small models often skip tools or call them badly. | Keep the tool list short and the descriptions imperative. If the board is still empty and the reply is a long HTML fragment, move that reply into the html source. |
| Text only. `responseConstraint` is not available. Iframes do not get the API. | The lesson page is a sandboxed iframe. The app itself stays a top-level page so it can call the API. The iframe does not. |
| The user picks the model. The page cannot. | Read `localLLM.info()` for the status line only. |
| `localLLM.search(query, { maxResults })` (newer extensions) searches the web: Tavily with the user's key, or a Google results page in a minimized window when Tavily is missing or out of credits. It rejects with `NotAllowedError` unless the user ticked **Allow web search** for the site, and allows 10 searches per minute per site. | A **Web search** toolbar switch (off by default, kept in localStorage) adds a page-side `web_search` tool that calls `localLLM.search` and returns numbered results with short snippets, plus a `# Web search` section in the system prompt asking for a Sources list of links. The switch is disabled when the extension has no `search`. The lesson iframe allows popups so Sources links open in a new tab. |
| `localLLM.search(query, { includeImages: true })` adds `images: [{url, description?, sourceUrl?}]`. `localLLM.fetchImage(url)` (newer extensions) downloads one of those urls and resolves to `{url, type, blob}`; it needs the same site switch, and rejects urls the site's own searches did not return. | With web search on and `fetchImage` present, `whiteboard_add_image` and `whiteboard_remove_image` are offered, and saved copies are stored on the topic (see Saved images). |

Sampling: if the app sets `temperature` it also sets `topK`. Prefer `LanguageModel.params()` defaults so the user's model settings win.

## Assumptions

- The extension is installed, this site's origin is enabled, and a model is already selected. Opening the extension is the user's job. The app never links to `chrome://extensions` setup steps beyond one sentence in the blocked state.
- The app is served from a real origin (`http://localhost:<port>` in development). Ports are distinct origins to the extension.
- One learner, one browser profile. IndexedDB is the only store.
- The learner reads the whiteboard. The model is the author of the lesson in v1.

## Goal

A learner can:

1. Open the app and see a blank whiteboard and an empty dialogue.
2. Type a topic or a question and send it.
3. Watch a lesson appear on the whiteboard, written by the model through tools.
4. Keep talking. Answers use the lesson as the system prompt. Requests to change the lesson update the whiteboard.
5. Leave and come back. Every topic, its lesson, and its dialogue are still in IndexedDB.

## Non-goals for v1

- Installing, configuring, or downloading models for the extension.
- A server-side model fallback. If `LanguageModel` is missing or `availability()` is `"unavailable"`, the composer stays disabled.
- Learner accounts, sync, or export.
- The learner editing the lesson by typing on the board.
- Audio, quizzes as a separate widget, or browser-control tools. The extension playground's tools are not available to websites, and this app does not try to call them. Web search is the exception, through `localLLM.search`, and so are images it finds, saved through `localLLM.fetchImage` (see Saved images).
- Multiple whiteboard documents inside one topic.

## Layout

The page fills the viewport. Three columns:

| Column | Width | Role |
| --- | --- | --- |
| Topics | 240px | Reopen what IndexedDB has stored. Not specified as a visual requirement, but a stored topic that cannot be selected is not stored in any way the learner can use. |
| Whiteboard | remaining | The lesson. White surface (`#ffffff` in light mode), blank until a tool writes it. This is the main learning material. |
| Dialogue | 380px | The conversation with the backend. Composer pinned to the bottom. |

```
+------------------+--------------------------------+----------------------+
| Topics           | Whiteboard                     | Dialogue             |
| [New topic]      |                                | model · status       |
| Photosynthesis   |  (blank until the model        |                      |
| Quadratics       |   writes the lesson)           | learner messages     |
|                  |                                | model replies        |
|                  |                                | [ type a topic…  ]   |
+------------------+--------------------------------+----------------------+
```

The whiteboard placeholder ("The lesson will appear here.") is paint only. It is not part of the document and it is not sent to the model.

On a narrow window the topic column collapses to a menu. The whiteboard stays above the dialogue. The dialogue does not cover the board.

## What a turn does

```
learner sends text
  → append user message, save topic
  → session.promptStreaming(text)
       model may call whiteboard tools (page execute)
         each execute() updates the in-memory lesson, repaints the board, saves IndexedDB
         returns a short outline
       streamed tokens append to the assistant bubble
  → save the assistant message
  → if any tool changed the lesson, destroy the session
  → the next send creates a session whose system message is the lesson as it stands now
```

The first send on an empty board is the same path. The system message says the board is empty and tells the model to call `whiteboard_set` before it chats. The dialogue reply should be a short description of what landed on the board, not a second copy of the page source.

Switching topics destroys the current session first (the origin may only keep two). Opening a topic creates a session only on the next send, so browsing the list does not spend the session limit or wake the model.

## System prompt

One system message. Shape:

```
You teach with two surfaces.
The whiteboard is a page of html, css, js, svg, and json. Change it only by calling whiteboard tools.
The SVG is inserted in #lesson-svg. Draw with basic shapes (rect, circle, line, polygon, text), not long path data. Do not paste that same diagram into html.
Parsed JSON is lessonData inside the page, or null when json is empty. Put labels, steps, and numbers there when the script should stay stable.
The chat is for the learner. Keep chat replies short. Do not paste the page source into the chat.
If the whiteboard is empty, write the page with whiteboard_set.
Before editing a component, call whiteboard_view. Call whiteboard_snapshot to read what the page currently says.
A stored markdown document exists only after the learner stores the learning material. It is not the live page. Call whiteboard_store_material only when the learner asks to store it.

# Whiteboard
<character counts for html, css, js, svg, and json, or the single line "The whiteboard is empty.">

# Stored learning material
<stored markdown, only after the learner has stored it>
```

The fixed lines tell the model which surface to write to. The raw sources are not inlined. There is no second hidden prompt.

Dialogue history is replayed as `initialPrompts` after the system message (`{ role, content }` strings only). Tool traces are not replayed. The page already contains the result of those tools.

### Fitting the context window

Before `create()`, estimate size at about 4 characters per token (the extension's own fallback when the page cannot count yet). Reserve roughly 1,500 tokens for the new user message and the reply.

Order of what is kept:

1. The fixed instructions and the whiteboard status line.
2. The stored markdown, when it exists. If it does not fit, send the title, the section outline, and as many full sections as fit, from the top. Append a line listing the omitted section ids. The raw html, css, js, svg, and json stay out of the system message; the model calls `whiteboard_view` for those.
3. The most recent user/assistant turns that still fit. Drop oldest first.

The on-screen page and the IndexedDB copy stay complete. Only the system message is shortened.

After `create()`, if `session.measureInputUsage` is present, measure the assembled prompt once per topic open. If the estimate was wildly low, rebuild with a smaller lesson slice and recreate. Do this before the first `prompt` of that session.

## Whiteboard document

The live board is five strings: `html`, `css`, `js`, `svg`, and `json`. Each is `""` when unused. `materialMarkdown` is a separate string, `""` until the learner stores the learning material. The topic title comes from the first `<h1>` in `html`. SVG text does not set the title. If there is no `<h1>`, the title stays as it is, or `"New topic"` for a new board.

The page paints the five strings in a sandboxed iframe. `sandbox` is `allow-scripts` only, with no `allow-same-origin`, so the page script cannot read IndexedDB, the parent DOM, or the model API. The parent assigns `iframe.srcdoc` and does not insert the model string with `innerHTML`. The frame's CSP is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:;`.

Document order inside the frame:

- CSS in `<style>`
- `<div id="lesson-svg">` containing the SVG, omitted when `svg` is empty
- the HTML
- a script that sets `globalThis.lessonData` from the JSON, or `null` when `json` is empty. `<` in that script is escaped
- the user JS in a following `<script>`

`json` must parse as JSON. An empty string means there is no data. Each source, and the stored markdown, is capped at 200_000 characters. Invalid tool input throws. `execute()` exceptions are returned to the model as `Error: …` by the extension, which is the recovery path.

The board repaints after every successful `whiteboard_set`. The learner sees the page change while the model is still producing the chat reply. An empty board still shows the placeholder "The lesson will appear here." That sentence is paint only.

`document/markdown.ts` still parses stored markdown so a long `materialMarkdown` can be fitted into the system message. `document/ops.ts` remains the section-editing library and its tests. The live board does not call it.

Opening a database from version 1 copies `documentMarkdown` into `materialMarkdown`, renders that markdown to static HTML for `html`, and clears `css`, `js`, `svg`, and `json`. Opening it from version 1 or 2 adds `images: []`.

## Saved images

A topic keeps the pictures the model saved from web search in `TopicRecord.images`, so the board still shows them when the original link dies or the learner is offline.

- `whiteboard_add_image {url, description, source_url?}` is offered when web search is on and the extension has `localLLM.fetchImage` (Project14 downloads only urls its own search returned for this site). The page shrinks the copy to 1280 px on the longest side and re-encodes it as webp, then stores the Blob. The same url returns its existing id; a topic holds at most 20. When the download fails the entry is kept with `blob: null` and the board uses the original url.
- `whiteboard_remove_image {id}` deletes one. `whiteboard_view` with `"all"` lists `{id, description, url, cached}`.
- The page refers to an image as `board-image:ID` in html, css, or svg. When the frame is assembled each known id becomes a `data:` URL of the cached copy (the frame CSP allows `data:`, and its opaque origin can't use the parent's `blob:` URLs), or the original url. Unknown ids stay as written. The lesson js also gets `globalThis.lessonImages`, `{id: src}`.
- The system prompt lists saved images in the board status and adds an `# Images` block while the tool is offered. The Debug mode Images tab shows each copy with its id, size, and source.

## Tools

Four tools, all scoped to the topic that is open when the session is created. Closing over a topic id inside `execute` is required so a late tool result cannot write a topic the learner has already left. If the open topic id no longer matches, `execute` throws.

Descriptions below are the text passed as `description`. They are part of the prompt for models on prompted tool calling, so they say when to call the tool.

### `whiteboard_view`

Read one whiteboard source before editing it. Pass component html, css, js, svg, or json. Pass all only when you need every source and they are short.

```json
{
  "type": "object",
  "properties": {
    "component": { "type": "string", "description": "One of html, css, js, svg, json, or all." }
  },
  "required": ["component"]
}
```

Returns `{ component, source }` for one source. Returns the five sources for `all` when they total at most about 24_000 characters. Above that, returns `{ truncated: true, lengths, message }` and does not include the sources.

### `whiteboard_set`

Replace one whiteboard source: html, css, js, svg, or json. Use this to create the page and to change one component. json must be a JSON string, or empty when there is no data.

```json
{
  "type": "object",
  "properties": {
    "component": { "type": "string", "description": "One of html, css, js, svg, or json." },
    "source": { "type": "string", "description": "The full replacement for that component." }
  },
  "required": ["component", "source"]
}
```

Saves that source and repaints. Returns `{ component, characters }` and, for html, `title`. It does not echo the source. Invalid JSON throws and leaves the stored JSON unchanged. A source over 200_000 characters throws.

### `whiteboard_snapshot`

Read the visible text of the current page, including the SVG labels. Call this to see what the learner sees. This does not save anything.

```json
{ "type": "object", "properties": {} }
```

Returns `{ text, characters }` for every source. `text` is truncated when it is long. Parsing uses `DOMParser` so script text is not treated as visible copy.

### `whiteboard_store_material`

Save a markdown document of what the page teaches. Call this only when the learner asks to store the learning material. Do not change html, css, js, svg, or json.

```json
{
  "type": "object",
  "properties": {
    "markdown": { "type": "string", "description": "The learning material as markdown." }
  },
  "required": ["markdown"]
}
```

Returns `{ stored: true, characters }`. Empty markdown throws. The live page is unchanged.

The **Store learning material** button sends one user turn asking the model to write that markdown and call this tool, without changing the five sources. The button is disabled while a turn is busy or while all five sources are empty.

No tool rewrites the dialogue. Chat text is only the streamed reply.

## Empty-board fallback

Some local models will answer with the page in chat and never call a tool. After `promptStreaming` finishes, if all of the following are true, the app saves the assistant text as `html`:

- the board was empty at the start of the turn (all five sources blank)
- no tool succeeded during the turn
- the reply is longer than 400 characters and contains an HTML tag
- the user did not abort

Then replace the visible assistant bubble with: "I put the lesson on the whiteboard." Store that shorter sentence as the assistant message so the next system prompt and the next replay do not contain two copies of the page. The page lives only on the board. The topic title is the first `<h1>` in that HTML.

Do not run this fallback once the board has content. A later chat answer must stay in the dialogue.

## IndexedDB

Database name `learn-with-llm`, version 3. One object store, `topics`, `keyPath: "id"`. Index `byUpdated` on `updatedAt`.

```ts
interface TopicRecord {
  id: string;                 // uuid
  title: string;              // first <h1> in html; "New topic" until one exists
  html: string;
  css: string;
  js: string;
  svg: string;
  json: string;               // "" when there is no data
  materialMarkdown: string;   // "" until the learner stores it
  messages: DialogueMessage[];
  images: BoardImage[];       // pictures saved with whiteboard_add_image; see Saved images
  createdAt: number;
  updatedAt: number;
}

interface DialogueMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}
```

Writes:

- Creating a topic inserts one record and selects it.
- Sending a message writes the user message before `promptStreaming`, and the assistant message after it resolves.
- Each successful `whiteboard_set` writes that source, and the title when the source is html, plus `updatedAt`, before `execute` returns. `whiteboard_store_material` writes `materialMarkdown` and `updatedAt` only.
- Deleting a topic deletes the record. If it was open, destroy the session and select the next topic, or an empty new one if the list is empty.
- The app opens on the topic with the greatest `updatedAt`, or a new empty topic when the store is empty.

No second store. Messages stay on the topic record. A topic that grows past a few hundred turns can later be split; v1 does not need that.

## Dialogue panel

- Header: `localLLM.info().name` and backend, or "Local LLM" when `info()` fails. Secondary text is availability: ready, downloading (with `monitor` progress), or the blocked-state sentence.
- Transcript: user and assistant bubbles in order. An assistant bubble shows "Updating the lesson…" while a tool `execute` is in progress and no token has arrived yet. Streamed tokens replace that status.
- Composer: a multiline field and Send. Enter sends, Shift+Enter inserts a newline. Empty input does not send.
- Stop aborts the `AbortController` for the active prompt. The partial assistant text is discarded. Tool writes that already committed stay on the board and in IndexedDB.
- Errors from the backend render as a note under the transcript, not as an assistant message, so they are not replayed into `initialPrompts`.

| `error.name` | Note |
| --- | --- |
| `NotAllowedError` | The site is not allowed to use the model. Enable it in the Local LLM extension and reload. |
| `QuotaExceededError` | The lesson or the conversation is over the model's limit. Shorten the request. |
| `InvalidStateError` | The session was lost. The next send creates a new one. |
| `AbortError` | Cleared. No note. |
| `NetworkError`, `OperationError` | The request failed. Send again. |
| anything else | The message text. |

The composer is disabled while a prompt is in flight, except for Stop.

## Topic list

- "New topic" inserts an empty record and selects it.
- Rows show the title and the date of `updatedAt`. The open row is marked.
- Delete is per row, with the browser confirm dialog.
- Selecting a row loads its five sources into the whiteboard and its messages into the dialogue, and drops any session for the previous row.

## Project shape

Vite and TypeScript, no UI framework. The tool executors call DOM updates directly, which keeps the data flow visible. Dependency list: `vite`, `typescript`, and a markdown parser for stored learning material. IndexedDB is used through the platform API.

```
index.html
src/main.ts                 boot: open DB, paint shell, bind backend status
src/styles.css
src/ui/shell.ts             columns
src/ui/topics.ts            list, create, select, delete
src/ui/whiteboard.ts        sandboxed iframe, placeholder, snapshot text
src/ui/dialogue.ts          transcript, composer, status, errors
src/document/markdown.ts    parse stored markdown so it can be fitted
src/document/static-html.ts one-time markdown to static HTML for old topics
src/document/ops.ts         section library kept for its tests; the board does not call it
src/storage/db.ts           IndexedDB, version 2
src/llm/backend.ts          wait for LanguageModel, availability, info
src/llm/system-prompt.ts    build the system message and trim stored markdown
src/llm/tools.ts            view, set, snapshot, and store
src/llm/turn.ts             create session, stream, fallback, recreate after edits
src/types.ts
```

`turn.ts` owns the session reference. UI modules do not call `LanguageModel` themselves. They call `send(topicId, text)` and subscribe to board and transcript changes.

Suggested module boundaries, and nothing tighter: `document/ops.ts` is pure string in, string out, and is the unit-test core. `tools.ts` adapts those operations to the Prompt API tool shape.

## Build order

1. **Shell.** Static layout, empty whiteboard, empty dialogue, fake topic rows. No model.
2. **Storage.** IndexedDB repository and the topic list wired to it. Reload keeps the selection.
3. **Document operations.** Parse, serialize, and the four mutations, with unit tests, still with no model.
4. **Board rendering.** Operations paint the whiteboard.
5. **Backend status.** Detect `LanguageModel`, show availability, disable the composer when it is absent.
6. **One turn without tools.** Session system message is the whiteboard status. Stream the reply into the dialogue. Persist both sides.
7. **Tools.** Pass the four tools into `create()`. Confirm a scripted model can fill a blank board, and that the following turn's system message shows the new source length.
8. **Budget and session refresh.** Trim long lessons, recreate the session only after a changing turn, destroy on topic switch.
9. **Empty-board fallback and errors.** The cases in the tables above.

Each step is usable on its own. Step 6 already talks to the backend. Step 7 is the feature that makes the whiteboard the lesson rather than a chat log.

## Tests

Unit tests (Vitest), no extension required:

- Section ids survive a serialize → parse round trip.
- `replace_section` changes one section and leaves the others byte-for-byte.
- `insert_section` honors `afterSectionId` and allocates a unique id.
- The system message for an empty board contains "The whiteboard is empty." and does not contain the placeholder sentence from the CSS.
- A lesson larger than the budget becomes an outline plus a prefix of sections, and the omitted ids are listed.
- The empty-board fallback fires only for a long HTML reply on an empty board.
- `whiteboard_set` writes one source, rejects invalid JSON, and refuses a topic that is no longer open.
- `whiteboard_store_material` saves markdown and leaves the page unchanged.
- The iframe `sandbox` is `allow-scripts`, and the parent board does not parse the page source as its own HTML.

A fake `LanguageModel` in tests records `create().initialPrompts`, and its `promptStreaming` invokes a tool the test names, then yields a short reply. Assert the system message of the *next* `create()` shows the length of the tool's write.

Manual check against the extension, after the unit tests pass:

- Serve the app (`vite`), enable that exact origin, and set the extension model to **Echo** to confirm wiring: send, stream, stop, topic switch, reload.
- Repeat with a real model that `localLLM.info()` reports as `tools: "native"`, then with a small local model (`tools: "prompted"`), and confirm the fallback path still puts a lesson on the board.

Echo will not call tools. That is expected. The manual tool check needs a real model. Do not block step 7's unit tests on Echo.

## Risks

- **Prompted tool calling on small models.** The default local model is small. The fallback covers the empty board only. Later edits may be ignored or written into the wrong source. The plan accepts that and keeps tool results explicit so a bad call throws back to the model within the 8 rounds.
- **Stale system prompt inside one turn.** Rounds 2–8 of the same `prompt` still see the lesson from `create()` time. Tool results carry the new outline so the model is not blind. The following learner message sees the new lesson, because the session is recreated.
- **Context budget.** A long lesson crowds out dialogue. The trim order above prefers the lesson, which matches the requirement that the learning material is the system prompt.
- **Tool side effects on abort.** A stopped reply can leave a half-updated lesson. The board shows the truth, and the discarded chat text is not replayed. The next turn's system message matches the board.
- **Consent and session loss.** `InvalidStateError` after an extension reload is recovered by creating a session on the next send. The lesson is in IndexedDB, not in the extension.
