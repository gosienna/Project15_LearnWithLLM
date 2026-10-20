# Learn with LLM — Build Plan

Oct 20, 2026

A single-page web app. The learner types a question or a topic in a dialogue panel. The model, served by the already-installed [Project14 Chrome LLM backend](https://github.com/gosienna/Project14_ChromeLLMBackend), writes the lesson onto a whiteboard in the center of the page and keeps editing that lesson as the conversation continues. Each topic is stored in IndexedDB. The text on the whiteboard is the system prompt for the next turn.

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
| `create()` takes one system message, then user/assistant turns. The system message is fixed for the life of the session. | Put the current whiteboard text in that system message. After a turn that changes the board, destroy the session and create another one so the next turn sees the new lesson. |
| Tools are declared on `create()`. `execute()` runs in the page. The extension only sees the name, description, and input schema. At most 32 tools. Names match `/^[A-Za-z_][\w-]{0,63}$/`. | All whiteboard edits are page-side tools. They update the DOM and IndexedDB, then return a short result. |
| A prompt may run up to 8 tool rounds. Tool results count toward the context window. | Return an outline, not the whole lesson, from each tool. |
| Default budget is 2 sessions per origin, 8192 context tokens, 20k tokens/minute. Oldest non-system turns are dropped when the session overflows. One prompt larger than the quota rejects with `QuotaExceededError`. | One live session. Fit the lesson first, then as much recent dialogue as remains. |
| `promptStreaming()` yields text deltas. Aborting drops that turn from the conversation. Tool `execute()` is not cancelled by the prompt signal. | Stream into the dialogue. Persist each successful tool write immediately, even if the user stops the reply. |
| Local models that lack native tool calling use prompted tool calling. Small models often skip tools or call them badly. | Keep the tool list short and the descriptions imperative. If the board is still empty and the reply is clearly a lesson, move that reply onto the board. |
| Text only. `responseConstraint` is not available. Iframes do not get the API. | The lesson is markdown text. The app is a top-level page, not framed. |
| The user picks the model. The page cannot. | Read `localLLM.info()` for the status line only. |

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
- Images, audio, quizzes as a separate widget, web search, or browser-control tools. The extension playground's tools are not available to websites, and this app does not try to call them.
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

The first send on an empty board is the same path. The system message says the board is empty and tells the model to call `whiteboard_replace_document` before it chats. The dialogue reply should be a short description of what landed on the board, not a second copy of the lesson.

Switching topics destroys the current session first (the origin may only keep two). Opening a topic creates a session only on the next send, so browsing the list does not spend the session limit or wake the model.

## System prompt

One system message. Shape:

```
You teach with two surfaces.
The whiteboard is the lesson. Change it only by calling whiteboard tools.
The chat is for the learner. Keep chat replies short. Do not paste the lesson into the chat.
If the whiteboard is empty, write the lesson with whiteboard_replace_document, then tell the learner what you added.
If the learner asks to change the lesson, edit the section with whiteboard_replace_section or whiteboard_insert_section.
If the learner asks a question, answer in chat. Update the whiteboard only when the answer should become part of the lesson.

# Learning material
<whiteboard markdown, or the single line "The whiteboard is empty.">
```

The learning material is the body of that message. The fixed lines above it exist so the model knows which surface to write to. There is no second hidden prompt.

Dialogue history is replayed as `initialPrompts` after the system message (`{ role, content }` strings only). Tool traces are not replayed. The lesson already contains the result of those tools.

### Fitting the context window

Before `create()`, estimate size at about 4 characters per token (the extension's own fallback when the page cannot count yet). Reserve roughly 1,500 tokens for the new user message and the reply.

Order of what is kept:

1. The fixed instructions.
2. The lesson. If it does not fit, send the title, the section outline, and as many full sections as fit, from the top. Append a line listing the omitted section ids and tell the model to call `whiteboard_read` for one of them.
3. The most recent user/assistant turns that still fit. Drop oldest first.

The on-screen lesson and the IndexedDB copy stay complete. Only the system message is shortened.

After `create()`, if `session.measureInputUsage` is present, measure the assembled prompt once per topic open. If the estimate was wildly low, rebuild with a smaller lesson slice and recreate. Do this before the first `prompt` of that session.

## Whiteboard document

The stored lesson is a markdown string. Sections carry stable ids in HTML comments so tools can name them:

```md
# Photosynthesis

<!-- section:overview -->
## Overview

Plants store energy from light in sugar.

<!-- section:calvin-cycle -->
## The Calvin cycle

...
```

Rules for the parser and the serializer:

- The first `#` line is the title. It is also the topic title shown in the left column.
- A section starts at `<!-- section:ID -->` and runs until the next section comment or the end of the document.
- Ids match `[a-z0-9-]{1,48}`. The tool layer generates one from the heading when the model omits it, and suffixes `-2`, `-3` on collision.
- Serializer output is stable: title, blank line, then each section as comment, heading, body. The board renders that markdown. The comment lines are not shown.
- Invalid tool input throws. `execute()` exceptions are returned to the model as `Error: …` by the extension, which is the recovery path.

Rendering uses a markdown library and a sanitizer. Raw HTML in the model output is escaped. Links may open. Scripts never run. Math rendering can wait; fenced code and lists cannot, because lessons need them.

The board repaints from the markdown string after every successful tool. The learner sees the lesson grow while the model is still producing the chat reply.

## Tools

Five tools, all scoped to the topic that is open when the session is created. Closing over a topic id inside `execute` is required so a late tool result cannot write a topic the learner has already left. If the open topic id no longer matches, `execute` throws.

Descriptions below are the text passed as `description`. They are part of the prompt for models on prompted tool calling, so they say when to call the tool.

### `whiteboard_read`

Read the lesson. Call this before editing when the system message lists section ids that were omitted, or when you need the current body of one section.

```json
{
  "type": "object",
  "properties": {
    "sectionId": { "type": "string", "description": "Section to return. Omit for the title and the list of section ids and headings." }
  }
}
```

Returns `{ title, sections: [{ id, heading }] }` or `{ id, heading, markdown }`. Never the whole lesson when a `sectionId` was omitted and the lesson is large: the outline only, capped at 80 sections.

### `whiteboard_replace_document`

Replace the entire lesson. Use this for the first lesson on an empty board, or when the learner asks to start the lesson over.

```json
{
  "type": "object",
  "properties": {
    "markdown": { "type": "string", "description": "Full lesson in markdown. Start with a single # title. Use ## headings for sections." }
  },
  "required": ["markdown"]
}
```

The executor inserts `<!-- section:id -->` before every `##` / `###` that lacks one, then saves. Returns `{ title, sections }`. Rejects empty markdown and markdown over 200_000 characters.

### `whiteboard_replace_section`

Replace one section's heading and body. Use this for corrections and expansions of a part that already exists.

```json
{
  "type": "object",
  "properties": {
    "sectionId": { "type": "string" },
    "heading": { "type": "string" },
    "body": { "type": "string", "description": "Markdown body, without the heading line." }
  },
  "required": ["sectionId", "body"]
}
```

Unknown id throws with the current outline in the error message so the model can recover inside the same prompt. Returns `{ id, heading }`.

### `whiteboard_insert_section`

Add a section. Use this when the learner wants new material kept on the board.

```json
{
  "type": "object",
  "properties": {
    "afterSectionId": { "type": "string", "description": "Insert after this section. Omit to insert after the title." },
    "heading": { "type": "string" },
    "body": { "type": "string" },
    "level": { "type": "integer", "description": "2 or 3. Default 2." }
  },
  "required": ["heading", "body"]
}
```

Returns `{ id, heading, afterSectionId }`.

### `whiteboard_delete_section`

Remove one section. Use this only when the learner asks to remove material.

```json
{
  "type": "object",
  "properties": {
    "sectionId": { "type": "string" }
  },
  "required": ["sectionId"]
}
```

Returns `{ deleted: sectionId, sections }`.

No tool rewrites the dialogue. Chat text is only the streamed reply.

## Empty-board fallback

Some local models will answer with the lesson in chat and never call a tool. After `promptStreaming` finishes, if all of the following are true, the app itself performs `whiteboard_replace_document` with the assistant text:

- the board was empty at the start of the turn
- no tool succeeded during the turn
- the reply is longer than 400 characters and contains a line matching `^# `
- the user did not abort

Then replace the visible assistant bubble with: "I put the lesson on the whiteboard." Store that shorter sentence as the assistant message so the next system prompt and the next replay do not contain two copies of the lesson. The lesson lives only on the board.

Do not run this fallback once the board has content. A later chat answer must stay in the dialogue.

## IndexedDB

Database name `learn-with-llm`, version 1. One object store, `topics`, `keyPath: "id"`. Index `byUpdated` on `updatedAt`.

```ts
interface TopicRecord {
  id: string;                 // uuid
  title: string;              // mirrors the lesson's # title; "New topic" until one exists
  documentMarkdown: string;   // "" when the board is blank
  messages: DialogueMessage[];
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
- Each successful tool writes `documentMarkdown`, `title`, and `updatedAt` in its own transaction before `execute` returns.
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
- Selecting a row loads its markdown into the whiteboard and its messages into the dialogue, and drops any session for the previous row.

## Project shape

Vite and TypeScript, no UI framework. The tool executors call DOM updates directly, which keeps the data flow visible. Dependency list: `vite`, `typescript`, a markdown parser, and `dompurify`. IndexedDB is used through the platform API.

```
index.html
src/main.ts                 boot: open DB, paint shell, bind backend status
src/styles.css
src/ui/shell.ts             columns
src/ui/topics.ts            list, create, select, delete
src/ui/whiteboard.ts        render markdown, placeholder
src/ui/dialogue.ts          transcript, composer, status, errors
src/document/markdown.ts    parse and serialize section ids
src/document/ops.ts         replace document, replace/insert/delete section
src/storage/db.ts           IndexedDB
src/llm/backend.ts          wait for LanguageModel, availability, info
src/llm/system-prompt.ts    build the system message and trim to the budget
src/llm/tools.ts            the five tool declarations and execute()
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
6. **One turn without tools.** Session system message is the current markdown. Stream the reply into the dialogue. Persist both sides.
7. **Tools.** Pass the five tools into `create()`. Confirm a scripted model can fill a blank board and then patch one section, and that the following turn's system message contains the edited lesson.
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
- The empty-board fallback fires only in the case described above.

A fake `LanguageModel` in tests records `create().initialPrompts`, and its `promptStreaming` invokes a tool the test names, then yields a short reply. Assert the system message of the *next* `create()` contains the tool's write.

Manual check against the extension, after the unit tests pass:

- Serve the app (`vite`), enable that exact origin, and set the extension model to **Echo** to confirm wiring: send, stream, stop, topic switch, reload.
- Repeat with a real model that `localLLM.info()` reports as `tools: "native"`, then with a small local model (`tools: "prompted"`), and confirm the fallback path still puts a lesson on the board.

Echo will not call tools. That is expected. The manual tool check needs a real model. Do not block step 7's unit tests on Echo.

## Risks

- **Prompted tool calling on small models.** The default local model is small. The fallback covers the empty board only. Later edits may be ignored or applied to the wrong section. The plan accepts that and keeps tool results explicit so a bad call throws back to the model within the 8 rounds.
- **Stale system prompt inside one turn.** Rounds 2–8 of the same `prompt` still see the lesson from `create()` time. Tool results carry the new outline so the model is not blind. The following learner message sees the new lesson, because the session is recreated.
- **Context budget.** A long lesson crowds out dialogue. The trim order above prefers the lesson, which matches the requirement that the learning material is the system prompt.
- **Tool side effects on abort.** A stopped reply can leave a half-updated lesson. The board shows the truth, and the discarded chat text is not replayed. The next turn's system message matches the board.
- **Consent and session loss.** `InvalidStateError` after an extension reload is recovered by creating a session on the next send. The lesson is in IndexedDB, not in the extension.
