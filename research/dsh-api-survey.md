# DSH 0.2.1-rc.2 API survey for dsh-tmux-xc

Read-only source investigation, 2026-10-17. No build, install, test, typecheck, network probe, or DSH lifecycle operation was performed. This report is the only file written. Examples below are proposed integrations, not executed code.

**Path notation:** `D` = `/mnt/data2/weizhiwei/gemini-fullstack-langgraph-quickstart/node-v22.16.0-linux-x64/lib/node_modules/@deepseek-ai/dsh`; `P` = `D/node_modules/@deepseek-ai`. Every `P/package/...` below expands to an exact installed path. CLI `D/package.json` reports `0.2.1-rc.2`; `dsh-client-modules/lib/index.js:544` reports client release commit `332895e`. Declaration locations matter: many are `lib/types/...`, not `lib/index.d.ts`.

**Design conclusion:** use a Cordis host service + React client right-sidebar tab; a plugin-owned canonical tmux reference token and input-trigger codec; durable registry through one host-owned storage domain; agent operations through `ctx.tools`, with an explicit pre-execute policy for mutation. Generic tools are allowed by default, so registration alone does **not** enforce dangerous-action approval. Composer chips serialize to text: persistence, history chip rendering, and preservation in the model's post-compaction context are three separate concerns.

## 1. Packaging, profiles, configuration

| Surface | Exact API / behavior | Source |
|---|---|---|
| Package roles | `DshManifest { manifestVersion?: 1; bundle?: DshBundleManifest; profile?: DshProfileManifest; client?: DshClientManifest }` | `P/dsh-package-manifest/lib/types/types.d.ts` |
| Bundle | `DshBundleManifest { patch: string \| string[] }`; paths relative to declaring package; arrays applied in order | same |
| Client | `DshClientManifest { platform: string; inject?: string[]; immediately?: boolean; external?: string[] }` | same |
| Client loading vs service injection | Manifest `client.inject` contains **package names**, drives client graph/order. Exported client `inject = ['slots', ...]` contains **Cordis services**. `external` lists exact runtime module-table requests beyond baseline, including `/client` subpaths; type-only imports need no runtime entry | same; `P/dsh-client-modules/lib/index.js:65–74, 413–438, 725–748` |
| Host entry | ESM package exports `apply(ctx: Context, config: Config): void \| Promise<void>`, `inject`, optionally `name`, `Config`; service plugins can default-export a `Service` subclass with `static inject` / `static Config` | `P/dsh-tool-terminal/lib/index.js`; `P/dsh-user-approval/lib/types/index.d.ts` |
| Patch application | `applyEntryPatches(data: EntryOptions[], patches: PatchOptions[] \| undefined, warn: (message: string, ...args: any[]) => void): EntryOptions[]` | `P/cordis-plugin-include/lib/types/index.d.ts`; implementation `lib/index.js` and `src/index.ts` |
| Patch fields | `PatchOptions { id?: string; insert?: EntryOptions[]; name?: string; config?: any; group?: boolean \| null; disabled?: boolean \| null; inject?: any; intercept?: any; isolate?: any; [key: string]: any }`. An `insert` without id appends root entries; with id it appends children to an existing group. Non-insert patches require id; optional name is a match guard, not a rename. Override fields are assigned at the entry level (config is replaced, not deep-merged). Entries inserted earlier in a list can be targeted later. Unmatched patches warn and skip. `!!js` values are loader expressions | same |
| Profile layer order | Ordered `dsh.profile.bundles` package patches → profile `cordis.patch.yml` → **home** `$DSH_HOME/cordis.patch.yml` → repeatable CLI `--patch` → telemetry overlay. `cordis.yml` is the empty root `[]`, not the place for user overrides | `D/lib/profile-boot-C14i-8IN.js:109–127, 224–229`; `P/dsh-app-boot/lib/types/profile.d.ts` (`composeEntries(layers: readonly PatchOptions[][], warn?: (message: string) => void): EntryOptions[]`) |
| Installation | `dsh plugin --profile X add <spec>` forwards to the installation-owned pnpm in `$DSH_HOME/profiles/X`, then reconciles newly added dependencies declaring `dsh.bundle` into `dsh.profile.bundles`. A dependency without that field stays a plain dependency | `D/lib/bin.js:115–124`; `D/lib/plugin-BiveYA7h.js:63–98`; `P/dsh-plugin-manager/lib/types/operations.js:71–123` |
| Local / tarball | **Allowed.** `anchorPathSpec(argument: string, cwd: string): string` anchors `./`, `../`, `file:./`, `link:../` against the invoking cwd before pnpm changes directories. `parseInstallSpec(raw)` accepts absolute paths, `file:`/`link:` absolute paths, `.tgz`/`.tar.gz`, HTTP tarballs, registry and git specs. The UI parser rejects relative paths; CLI anchors them first | `P/dsh-plugin-manager/lib/types/operations.js:66–75`; `lib/types/install-spec.js:16–80` |
| Existing profiles | Inspected `/mnt/data2/weizhiwei/.dsh/profiles/{web,autoctx,ds41_flash}/{package.json,cordis.yml,cordis.patch.yml}`. All three root YAML files are `[]`; custom entries/config are in patches; manifest examples include `link:/absolute/path`. Historical `patchReload` fields occur in manifests, but are absent from the current public `DshProfileManifest`; do not assume they control current HMR | inspected files; current manifest declaration above |

Minimal package shape (proposed; artifact paths chosen by the plugin):

```json
{
  "name": "dsh-tmux-xc", "type": "module", "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-input-trigger"]
    }
  }
}
```

```yaml
- insert:
    - id: tmux-xc
      name: dsh-tmux-xc
```

`P/dsh-client-modules/lib/index.js:725–748` discovers metadata from **loader entries**, requires `platform === 'web'` and `exports['./client']`; missing declared client artifacts fail activation. It serves revisioned `/plugins` combo resources (`/plugins/??<pkg>/client.js&rev=...`) and chunks; also uses package client paths for inventory. Client bundles register lazy factories with `window.__ModuleLoader__.load({ id, factory })`; factory materialization returns Cordis plugin exports. This is not an arbitrary ESM `<script>` import. See `lib/index.js:17–29, 201–229, 448–505, 565–572` and `lib/client.js` loader implementation. Package-name `/client` requests alias the corresponding package graph row. Ship the already-built client artifact; runtime does not compile TSX.

Configuration: export `Config = z.object({...})` using default `z` from `@deepseek-ai/schemastery` (not domain-storage's Zod). Examples: `P/dsh-storage-json/lib/index.js:551`, `/mnt/data2/weizhiwei/dsh-autoctx/index.js:137`. `ctx.settings` is `SettingsForms`, not a general registry store:

```ts
// P/dsh-settings/lib/types/index.d.ts
configure(presentation: { auto?: boolean }, owner?: Fiber): () => void;
describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
```

Descriptors include schema/value/revision and `applies: 'live'`; writes use the user configuration document. Client `ctx.configForms.get<T>(entryId): ConfigForm<T>` and `whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void` are declared in `P/dsh-client-ui-settings/lib/types/client/config-form.d.ts`. Custom pages register `settings.section`; plugin-specific forms use keyed `plugins.row.config`. Concrete example: `/mnt/data2/weizhiwei/dsh-autoctx/client.js:811–831` waits for a served config namespace then registers both. Use entry identity supplied by settings descriptors, not an invented namespace.

## 2. Client panel and current session

The shipped UI uses **React**, with a **Lexical** composer. Cordis owns extension lifetimes; hooks/stores are supplied through slot props. `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-ui-slots` have **no standalone installed directory at P**. The former is referenced by old `dsh-tmux-cc` metadata, so its old APIs are not established for this release. The latter remains an active module-table/type contract: current renderer and feature bundles import it. Do not interpret missing disk directory as missing browser slot support.

| API | Signature / integration | Declaration / code |
|---|---|---|
| Slots provider | `ctx.slots: SlotRegistry`; `readonly register: SlotCore['register']`; `inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void` (callback installs a disposer or iterable of disposers) | `P/dsh-client-ui-renderer/lib/types/client/registry.d.ts`; `lib/client.js:1305, 1813` |
| Sidebar provider | `ctx.sidebarRightTabs.register(definition: SidebarRightTabDefinition): () => void` | `P/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts` |
| Tab definition | `{ id: string; kind: string; multiple?: boolean; keepMounted?: boolean; patterns?: readonly string[]; priority?: 'extension' \| 'builtin' \| 'fallback'; canOpen?: (address: string) => boolean; title: (address: string) => string; guide?: readonly SidebarRightGuideEntry[] }` | same |
| Tab content | Keyed **session** slots `sidebar.right.pane.tab` and `.title`; registration `key` must match the tab provider id. `inject: (sessionId) => ({...})` supplies plugin-owned props | `P/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts`; official example `P/dsh-client-ui-sidebar-terminal/lib/client.js:438–489` |
| Open tab | `ctx.sidebarRight.openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void`; explicit target `openTabIn(sessionId, kind, options?)`; `mounted: ObservableSnapshot<SessionId \| undefined>` | `P/dsh-client-ui-sidebar-right/lib/types/client/service.d.ts` |
| Resource navigation | `openResource(address: string, options?: SidebarRightOpenResourceOptions): void`; provider patterns/canOpen claim addresses | same |
| Tab hooks | Injected `hooks.tabInfo`; `SidebarRightTabInfo.tab` has `id`, `visible`, `navigation`, `signal`, `actions`; actions include `openTab`, `openResource`, `close` | `.../contract/slots.d.ts` |
| Layout | `ctx.layout` integration is described by `ILayout`: `selectPanel(panelId: MainPanelId \| null)`, `toggleSidebar()`, `openRightbar(track: boolean, fullscreen: boolean)`, `closeRightbar()` | `P/dsh-client-ui-layout/lib/types/client/service.d.ts` |
| Session context | `scopeOf(ctx: Context): SessionId \| undefined` from `@deepseek-ai/dsh-api-session-controller/client`; `ctx.sessions.sessionOf(ctx): SessionFace \| undefined`; `binding(id): SessionBinding \| undefined`, with `{sessionId, session, eventSource, ctx: AgentContext}` | `P/dsh-api-session-controller/lib/types/client/{scope.d.ts,contract/sessions.d.ts,sessions/service.d.ts:79}` |

Proposed tab registration, following the official terminal pattern:

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'tmux-xc', kind: 'tmux-xc', title: () => 'tmux', keepMounted: true,
}));
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'tmux-xc',
    inject: sessionId => ({ sessionId }),
  }, TmuxPanel)));
// A user interaction can call ctx.sidebarRight.openTab('tmux-xc').
```

Use the session id supplied by this **mounted session slot**, and re-check current binding when an async operation completes. A root Cordis context has no unique current chat. `sidebarRight.mounted` tracks the on-screen session for root-level controls. Avoid URL parsing or DOM selectors. Do not register `root`: it is a single slot occupied by AppFrame and an extension there can shadow the whole application (`renderer/.../registry.d.ts` warning). A floating additive surface can use `shell.overlay`; the right tab is the appropriate regular panel here.

## 3. Composer, custom reference kinds, durable messages and compaction

There is no generic host-side `registerReferenceKind()` discovered in the named packages. Extension is composed from **input trigger source + codec + history text rule + renderer + host/tool resolver**. File and cross-session references are distinct implementations, not a universal tmux provider protocol.

Exact public shapes:

```ts
// P/dsh-client-ui-input-trigger/lib/types/types.d.ts
interface ReferenceCodec {
  clipboardText(ref: string): string;
  serialize(ref: string, signal: AbortSignal): Promise<string>;
}
interface InputTriggerSource {
  readonly trigger: '/' | '@'; readonly name: string; readonly order?: number;
  candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>;
  onPick(pick: InputTriggerPick): PickOutcome;
  // optional matchSpace, matchEnter, matchClaim, openReference, warm, lexicon, ...
  readonly codec?: ReferenceCodec;
}
// P/dsh-client-ui-input-trigger/lib/types/client/contract.d.ts
registerSource(src: InputTriggerSource): () => void;
sessionOf(actx: ClientContext): InputTriggerController;

// P/dsh-client-ui-conversation/lib/types/client/contract/draft-editor.d.ts
interface ReferenceInsert {
  readonly source: string; readonly ref: string; readonly label: string;
  readonly appearance?: 'session' | 'file' | 'folder';
  readonly clipboardText: string;
}
interface TokenSpan { readonly start: number; readonly end: number; readonly draftRev: number; }
// .../contract/input.d.ts and .../service.d.ts
ctx.conversation.input.for(actx: Context): SessionInput;
SessionInput.insertReference(ref: ReferenceInsert, span: TokenSpan): boolean;
SessionInput.focus(): void;
InputActions.captureInsertion(): TokenSpan;
```

The snippets abbreviate the optional source members; full declaration is at the cited path. Register a unique source name such as `tmux-xc` through `ctx.inputTriggers.registerSource`. `onPick` returns `{ insert: ReferenceInsert }`. For a sidebar-only button the source can have an empty candidate list, while its codec still supplies submission behavior. `appearance` currently has only three built-in visual categories: a custom source is possible without a custom tmux-specific built-in icon category.

**Programmatic insertion without sending:** all session slots receive `inputActions` in `SessionStandardProps` (`P/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:415–432`). On pointer-down capture `props.inputActions.captureInsertion()` if caret placement matters; on click insert through the *same* retained session binding. Alternatively a synchronous append can construct a revision-checked span from `input.state.getSnapshot()`:

```js
// Proposed button handler; sessionId is from this mounted panel.
const binding = ctx.sessions.binding(sessionId);
if (!binding) throw new Error('The chat session is no longer mounted');
const input = ctx.conversation.input.for(binding.ctx);
const s = input.state.getSnapshot();
const span = { start: s.draft.length, end: s.draft.length, draftRev: s.draftRev };
const ok = input.insertReference({
  source: 'tmux-xc', ref: canonicalRef, label: paneLabel,
  clipboardText: canonicalRef,
}, span);
if (!ok) throw new Error('The composer changed or is busy; reference was not inserted');
input.focus();
```

Insertion never calls `send`/`submit`. For caret insertion use captured `TokenSpan` instead of the append span; do not recalculate a stale async span and silently target another chat. Alternative scoped event: `'slash/input-insert-reference'(request: { reference: ReferenceInsert; span: TokenSpan }): true | undefined` is declared in `.../contract/input.d.ts`. The direct `SessionInput` API is easier to check. Implementation rejects a busy phase or revision mismatch (`P/dsh-client-ui-conversation/lib/client.js:15309–15314`); `captureInsertion` is at `14913`.

**Serialization and chip reconstruction:**

| Stage | Actual behavior and evidence |
|---|---|
| Draft | Occurrences retain `source`, `ref`, label, offsets, length, clipboard text and appearance. `DraftSnapshot` stores text + references. These are draft/editor records, not automatically message attachments (`.../contract/draft-editor.d.ts`; `lib/client.js:4411–4420`). |
| Submit | Each occurrence calls `inputTriggers.serializeReference(o.source, o.ref, attempt.signal)`; returned strings replace occurrence spans; `defaultSink(out.trim(), attachmentIds, mode, signal)` receives plain composed text (`conversation/lib/client.js:15500–15525`). Missing codec rejects, rather than silently flattening (`input-trigger/lib/client.js:1249–1252`). |
| Official @ references | Source name `reference`, codec `serialize: ref => Promise.resolve(ref)`; file refs become `@path` / `@"path with spaces"`; sessions become `@[label](dsh-session:…)` (`ui-reference/lib/client.js:294–365`). |
| Submitted history rendering | Register `ctx.uiConversation.userText.register(rule: UserTextRule): () => void`, then keyed `conversation.user.text.node` renderer. Rule has `{id, order, match(text, from, context)}` returning `{id,start,end,data}`. Extend `UserTextDataMap` for the custom id. Official file/folder rules and renderers are at `ui-reference/lib/client.js:67–112, 274–291`; declarations `conversation/.../contract/user-text.d.ts`, `.../conversation/user-text-registry.d.ts`. `UiConversation.userText` is declared in `.../conversation/assembly.d.ts`. Thus tmux tokens can reconstruct visible chips on reload. |
| Model input | Custom codec text is ordinary user text unless the plugin additionally expands it. Register a host resolver/tool which parses the canonical token and resolves stable registry identity. No automatic attachment or tmux expansion exists. Do not serialize a label alone or depend on browser-only source/ref metadata. |

`dsh-file-reference`: abstract `FileReferenceService.list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>`; exports `activeAtToken`, `formatFileMention`, `FILE_REFERENCE_PROMPT` (`P/dsh-file-reference/lib/types/index.d.ts`). `dsh-file-reference-local` supplies local cwd-bound file discovery; the prompt explicitly tells the model to use the read tool when contents are needed. This is path-only reference selection, not content mounting.

`dsh-session-reference`: `SessionReferenceResolver.prepare(agent: Agent, content: ContentBlock[], references: SessionReferenceInput[], signal?: AbortSignal): Promise<PreparedReferencedMessage>`; exports `SESSION_REFERENCE_SCHEME`, `encodeSessionReferenceUri`, `decodeSessionReferenceUri`, `formatSessionReferenceMention`, `parseSessionReferenceText` (`P/dsh-session-reference/lib/types/{index,types,uri}.d.ts`). Its pre-step hook **replaces** canonical mentions in direct `source.kind === 'user'` content, exact-reads source session surfaces, and emits an adjacent `UserMessage` source `{kind:'session-reference', form:'recall', version:1, references:[...capturedThroughSeq, stats...]}` containing an untrusted snapshot, with budgets/spill notices (`lib/index.js:470–510, 625–660`). It is specialized to *DSH sessions*, unsuitable for a tmux pane id.

**Durability evidence and its limit:** `P/dsh-agent-loop/lib/index.js:1067–1073` appends accepted pre-step messages as `user/message` events with `surfaceOp: 'append'`. `P/dsh-session-persistence-jsonl/lib/index.js:919–943, 3295–3332` writes/fsyncs event batches to `$DSH_HOME/sessions/<projectKey(cwd)>/<encoded-session-id>/<generation-log>`. Default physical compression is `zstd` (`:2290`), so files are JSONL with `.zstd`, not necessarily plain `.jsonl`; alternate `compression:'none'` exists. Original user text or explicitly transformed user text and prepared additional contexts persist according to that pre-step path.

`dsh-compaction-basic` does not promise token-level reference preservation. `lib/index.js:628–661` appends `compaction/summary`, then:

```js
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
});
```

Consequently the **original event remains in durable history**, while the active model surface uses a generated summary plus retained tail. A canonical tmux id may be omitted by summarization. To meet “survive compaction & reload” fully: keep immutable submitted reference identities in the message text and/or plugin-attributed durable event/context; register a session projection of active referenced ids; reintroduce a short deterministic reference index after compaction or expose it through an agent resolver/list tool. The global registry alone preserves targets, but does not preserve which message selected them. These are required plugin features, not guarantees of native chips. A host pre-step expansion should retain the canonical identity in accepted content, even if it adds a snapshot.

`dsh-mcp-resources` is another possible **agent resolution** seam, not composer insertion: `ctx.mcpResources.register(server: string, provider: McpResourceProvider): () => void`; provider `request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>` handles `resources/list`, `resources/templates/list`, `resources/read`. It registers normal tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` while providers exist (`P/dsh-mcp-resources/lib/types/index.d.ts`; `lib/index.js:48–92, 133–176`). A `tmux-xc://...` resource can be implemented here, but does not create UI chips by itself.

## 4. Agent tools, caller context, cancellation and approval

Use `@deepseek-ai/dsh-tools` exports `defineTool`, `ToolRuntime` (default), `ToolRunContext`, `PreToolDecision` and schema types. Relevant declarations: `P/dsh-tools/lib/types/{index,schema}.d.ts`.

```ts
ToolRuntime.register(definition: ToolDefinition): () => void;
ToolRuntime.execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>;
ToolRuntime.guard(guard: ToolGuard): () => void;
// Typed builder, exact signature:
defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>
): ToolDefinition;
// DefineToolOptions fields include:
// name, description, parameters: S,
// output: { schema: O; render(args, value): ContentBlock[]; presentationMeta?(args,value): JsonValue },
// execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>,
// optional timeoutMs, isConcurrencySafe, presentCall, presentResult, projectContent, finalizeContent.
```

Parameters use DSH's schema spec, e.g. `{ reference: { type:'string', required:true } }`, not a raw Zod object or whole JSON Schema. Nested object value specs require `additionalProperties`. Output schema and renderer are **mandatory** in this version; body returns a lossless JSON value, not the old `{content:[...]}` tool-response convention. `deferLoading?: true` and `timeoutMs?: number` are supported. Mark only genuinely safe read operations concurrency-safe; mutations remain exclusive by default.

`ToolExecutionInput` has `{callId, rootCallId?, name, schema?, arguments, agent?: Agent, parent?, signal: AbortSignal}`. `ToolRunContext` extends normalized execution and adds `deferContext(context: UserMessage): void` and turn-conclusion support. Require `exec.agent` for agent-owned operations; `exec.agent.session.id` gives session identity. Use that agent's execution world, e.g. `agent.ctx.get('workingDirectory')` / `agent.ctx.get('subprocess')`; do not invent `exec.cwd`.

`WorkingDirectoryService.get(session: Session): string` and `ensure(agent: Agent, signal?: AbortSignal): Promise<string>` are declared in `P/dsh-working-directory/lib/types/index.d.ts`. `ctx.workspaceRegistry.resolveByPath(path: string): Promise<Workspace | undefined>` maps cwd to workspace metadata (`P/dsh-workspace/lib/types/index.d.ts`); workspace identity and cwd are separate. Actual examples: `P/dsh-tool-terminal/lib/index.js:303` calls `ctx.workingDirectory.ensure(owner, exec.signal)`; bash `:663` does likewise. Forward `exec.signal` through every subprocess/network wait; do not return before owned work settles. `timeoutMs` is enforced by the optional `dsh-tool-call-timeout-policy`, not by the schema declaration alone.

`dsh-tool-cordis` is **read-only runtime inspection**, not the tool registrar: `cordis_inspect_list` / `cordis_inspect_query` use `ctx.tools.register(defineTool(...))` and `ctx.cordisInspect`; see `P/dsh-tool-cordis/lib/index.js:29–91`. `dsh-tool-ask-user` registers `ask_user_question` / related question functionality through `ctx.userQuestions`; answering a question is not tool approval (`lib/index.js:66,223`). `dsh-tool-bash` delegates shell/sandbox policy; it does not supply universal policies for arbitrary new tools (`lib/index.js:218` TODO and `:663`).

**Dangerous action approval must be deliberately wired.** Tool execution goes through `tools/pre-execute` → ask resolution → monotonic guards → around-dispatch → post-policy → final materialization (`P/dsh-tools/lib/index.js:3321–3322,3535–3580`). Default pre-decision is **allow**. Policy type:

```ts
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } };
```

A plugin pre-execute listener should await `next()`, preserve any non-allow result, and return `{kind:'ask',reason:...}` for its destructive actions. That enters the normal approval audit/UI channel before executing. Alternatively the body can call `ctx.approval.request(...)` explicitly and execute only for `'allowed-once'`, but it must not duplicate a pre-execute ask.

```ts
// P/dsh-user-approval/lib/types/index.d.ts
ApprovalService.request(req: ApprovalRequest): Promise<ApprovalOutcome>;
// req: { agent: Agent; toolName: string; callId?: ToolCallId;
//        reason?: string; signal?: AbortSignal; ...ApprovalRequestEvent }
type ApprovalPolicy = 'ask' | 'never';
// P/dsh-user-approval/lib/types/types.d.ts
// ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

`request` requires an **open agent turn**, appends `approval/asked` and `approval/decided`, and `'allowed-once'` is the sole grant (`lib/index.js:128–145`). Missing service/agent/answerer fails closed. Client approval registers a forwarded `approval/request` waterfall and the approval card (`P/dsh-client-ui-approval/lib/client.js`; `P/dsh-api-remotes/lib/index.js:29–32`).

Permission interactions: built-in presets combine sandbox and approval policies. `workspace-write` normally asks for escalation; `danger-full-access` uses `approval:'never'` (`P/dsh-permission-presets/lib/index.js:137–155`). **`never` rejects an explicit approval request**, it does not auto-grant it (`user-approval/lib/index.js:175`). Normal shell operations in full access avoid asking because no sandbox escalation is needed. If xc requires unconditional human approval for `close`, that operation will be denied in `never` mode unless the user changes policy; do not reinterpret rejection as authorization. The optional `auto` integration uses full access + `ask` and an additional admit integration (`permission-presets/lib/index.js:58–60,250–265`). `dsh-authorization` is credential/login flow orchestration (`registerFlow`, `begin`, `cancel`), **not** the dangerous-tool approval service (`P/dsh-authorization/lib/types/index.d.ts`). Direct `subprocess.spawn` supplies process lifecycle, not sandbox/permission enforcement.

## 5. Persistent registry and scopes

| Service | Exact API / source |
|---|---|
| Hub | `ctx.storage.form<K extends keyof StorageForms>(form: K): StorageForms[K]`; convenience `ctx.storage.domain`; `mount(form, facility): () => void`; `P/dsh-storage/lib/types/index.d.ts` |
| Domain | `ctx.storage.domain.open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`; also `ctx.storageDomain`; `P/dsh-storage-domain/lib/types/index.d.ts` |
| Definition helpers | `defineDomain<S extends DomainSpec>(spec: S): S`; `domainTable<K extends string,V>(schema: ZodType<V>): DomainTableSpec<K,V>`; `descriptorOf(spec): KvUnitDescriptor`; schema here is **Zod**, imported from `zod`; `lib/types/spec.d.ts` |
| Spec | `{name:string, version:number, layout?:'single'\|'per-record', compatibleVersions?: readonly number[], invalidRecords?:'backup-and-skip', global?:{schema,initial}, tables:Record<string,DomainTableSpec>}`; same |
| Table | `get(key): V \| undefined`, `entries(): IterableIterator<[K,V]>`, `keys()`, `size`, `put(key,value): Promise<void>`, `delete(key): Promise<boolean>`, `update(key,fn:(current:V)=>V): Promise<V>`; `lib/types/domain.d.ts` |
| Global | `get(): G`, `set(value:G): Promise<void>`; `Domain.close(): Promise<void>`; same |
| JSON backend | `JsonStorageBackend(root: string)`, `Config { root: string }`; backend registered as `json`; `P/dsh-storage-json/lib/types/index.d.ts` |
| Home | `resolveDshHome(configured?: string, env?: Record<string,string\|undefined>): string`, `dshHomePath(...segments:string[]): string`, `expandHomePath(path:string):string`; `DSH_HOME_ENV = 'DSH_HOME'`; `P/dsh-home-paths/lib/types/index.d.ts` |

Default base configuration sets session root to `dshHomePath('sessions')` and JSON storage root to `dshHomePath('storages')` (`P/dsh-base/cordis.patch.yml:141,185`). Registry layout: `single` → `<root>/<domain-name>.json`; `per-record` → `<root>/<domain-name>/<table>/<key>.json` plus `global.json` (`P/dsh-storage-json/lib/index.js:162–179,276–317,464–491`). Keys must be path-safe in per-record layout; encode opaque remote ids or use a stable safe registry id.

**No storage scope enum exists for global/profile/workspace/session.** Default storage is **user-home scoped across profiles and conversations**. For this task one host-owned domain named `dsh-tmux-xc` satisfies user-scoped shared persistence. If profile isolation is required, choose a profile-specific supported backend/root or explicit profile partition keys; workspace/session scope is likewise a key/root design decision. `dsh-scope` is an in-memory service/tool inheritance mechanism (`ScopeKey = object`, `createScope`, `scopeOf`, `ScopedLayers`), not disk storage scoping (`P/dsh-scope/lib/types/index.d.ts`). Do not open a new registry per chat.

Concurrency: a domain owns one in-memory map and **per-domain write chain**. Writes queue, await backend durability, then publish in-memory changes; `table.update` performs read-modify-write within that chain (`P/dsh-storage-domain/lib/index.js:96–120,221–224,258–290`). JSON backend enforces one live unit handle per domain name in a backend instance (`storage-json/lib/index.js:560–567`). Open once in the host service and share it. Separate get→await→put calls are not a transaction; use `update` or serialize compound registry operations explicitly. There is no multi-table transaction API here.

JSON atomic replace does **not** provide cross-process read/modify/write synchronization; the backend assumes its domain writer and documents last-write-wins (`storage-json/lib/index.js:9–16`). Multiple DSH processes using the same registry file need a deliberate ownership/concurrency design. `@deepseek-ai/dsh-atomic-write` exports:

```ts
writeFileAtomic(filename: string, content: string | Uint8Array,
  options: {mode:number; dirMode?:number}): Promise<void>;
withFileLock<T>(filename: string, operation: () => Promise<T>,
  options?: {signal?:AbortSignal; waitMs?:number}): Promise<T>;
```

`withFileLock` uses sibling `<filename>.lock`, exclusive `wx` creation, holder PID and exited-holder takeover (`lib/index.js:166–216`); storage-json does not automatically use it. Wrapping a stale in-memory domain write with this lock alone does not solve multi-process stale reads. Do not opt into `invalidRecords:'backup-and-skip'` to hide registry corruption; it is optional, not required for normal storage.

## 6. Host ↔ client: authenticated calls, schemas, events

Current high-level remotes are **Typert**. `dsh-sdk-protocol` is newline JSON-RPC SDK transport/types (`JsonRpcLineTransport`, `JsonRpcResponseError`, `HarnessSdkRequestMap`, `HarnessSdkNotificationMap` in `P/dsh-sdk-protocol/lib/types/index.d.ts`), not the browser extension RPC registrar.

| Route | Exported seam and exact signature | Notes |
|---|---|---|
| Typed service | `TypertRemoteService` from `@deepseek-ai/dsh-typert-protocol`; protected constructor `(ctx:Context, serviceKey:string, options?:{namespace?:string})`; `bindTypertRemote(service,serviceKey,options?)`; `Remote`, `RemoteScope` decorators | `P/dsh-typert-protocol/lib/types/index.d.ts`. Decorators mark methods; runtime registry must also have generated invocation descriptors/codecs. Copying a method onto `ctx` alone does not expose it. |
| Descriptor generation pattern | `createTypertRemoteInfo(spec: TypertRemoteSpec, zod: typeof z): TypertRemoteInfo`, generated `TYPERT` host contribution and `TYPERT_REMOTE` client contribution | Inspect complete example `P/dsh-session-reference/lib/{typert.host.js,typert.remote-client.js,typert.remote-client.d.ts}`. `P/dsh-typert-registry/lib/types/index.d.ts` declares `ctx.typert.register(contribution: TypertContribution): TypertDisposer`. |
| Gateway | `ctx.typertGateway.invoke(request: InvokeRemoteRequest): Promise<unknown>`; `stream(request): Promise<AsyncIterable<unknown>>`; request `{namespace,method,args,peer,signal?,uplink?,uplinkWindow?}` | `P/dsh-api-gateway/lib/types/{index,types}.d.ts`; validates descriptor arguments/results, resolves host context/lookups and access. |
| Browser typed call | `ctx.remote.sessionReferenceResolver.candidates(agentId:SessionId,query:string,signal?:AbortSignal): Promise<RemoteResult<SessionReferenceMentionCandidate[]>>`; agent-bound context can omit agentId | Verified generated example above. `RemoteResult` is `{ok:true,value}` or `{ok:false,error}`; inspect it, do not assume success. |
| Custom low-level RPC | `ctx.connection.rpc.handle(channel:string,handler:ConnectionRpcHandler): () => Promise<void>`; `intercept(channel:'/api', matches, handler)` | `P/dsh-client-connection/lib/types/rpc.d.ts`; handler `(endpoint:string,payload:unknown,signal:AbortSignal,peer:PeerScope)=>Promise<ConnectionRpcHandlerResult>`. Client contract `ClientConnectionRpc.call(channel,endpoint,payload,signal?): Promise<ConnectionRpcResult<unknown>>`. Explicitly validate payloads and principal/resource access. |
| **Simple supported HTTP option** | `ctx.connection.fetch.register(route: ConnectionFetchRoute): () => Promise<void>`; route `{path:string,methods:readonly ('GET'\|'HEAD'\|'POST')[],requestBody:'buffered'\|'streaming',fetch:(request:Request)=>Promise<Response>}` | same; registered exact `/api/...` routes travel through shared Connection carrier and are **owner-only** (`connection/lib/index.js:821–835`). This is a practical alternative when not shipping generated Typert code. |

Client HTTP example: `fetch(new URL('./api/tmux-xc/list', document.baseURI), { credentials:'same-origin', signal })`. This preserves document-relative hosting and DSH cookie auth. Register via Connection rather than an unguarded separate listener or guessed `/api` middleware. An HTTP JSON handler still needs domain validation and explicit allowed operations; browser authentication is not agent approval.

Authentication: Connection checks accepted Host authority (loopback/bind address/trustedHosts), rejects cross-site browser markers/Origin mismatch, and authenticates the browser using launch-token exchange → signed scoped session cookie. Authenticated browser peers have principal `{kind:'owner'}` (`P/dsh-client-connection/lib/index.js:139–268,410–500,714,737–783`). Do not copy/read the user's launch token into plugin state or create a bypass websocket. `dsh-api-remote-access` handles non-owner principals with `registerPolicy(kind,policy)`, `decide(request)`, `allows(resource)`, `snapshotFor(principal)`, `follow(signal)` (`lib/types/index.d.ts`); owner is separate from custom non-owner policy.

Push: a typed `Remote(...mode:'stream')` / `RemoteScope` method can return an async iterable; client `ctx.remote.$stream<Item>(options:RemoteStreamOptions<Item>): RemoteStream<Item>` and `RemoteSnapshotStream` / `RemoteJournalStream` are exported by `@deepseek-ai/dsh-api-gateway/client` (`lib/types/client/index.d.ts`). Gateway also has `registerRemoteEvents(source: (signal:AbortSignal)=>AsyncIterable<TypertRemoteEventDispatch>, host:RemoteEventHostInfo): () => Promise<void>` (`lib/types/types.d.ts`). **Arbitrary `ctx.emit` is not automatically forwarded**: `dsh-api-remotes/lib/index.js:20...` owns `API_REMOTE_FORWARDED_EVENTS`; browser `ctx.remote.$on(event,listener)` is typed to that registered vocabulary. For registry updates, a plugin-specific follow stream is clearer than assuming a new host event reaches browsers. Keep stream resources/access declarations aligned with the calling peer/session.

## 7. Terminals: agent registry versus user PTY

| Feature | Ownership / permission boundary |
|---|---|
| `dsh-terminal` | Agent-owned ephemeral registry: `spawn(owner:Agent,request:TerminalSpawnRequest,signal?):Promise<TerminalSpawnResult>`; `startSend(owner,id,request):TerminalSendOperation`; `read(owner,id,request?)`; `signal(owner,id,signal)`; `kill(owner,id,reason?)`; `list(owner)`. Requests use `{type,name?,cwd?}`. Foreign sessions rejected (`FOREIGN_SESSION`); cleanup tied to owner lifecycle. `P/dsh-terminal/lib/types/{index,types}.d.ts` and `lib/index.js`. Not a global persistent tmux registry. |
| `dsh-terminal-bash` | Backend for agent terminals, using subprocess PTY plus sandbox confinement; keeps sandbox-mode fences while terminals live. `P/dsh-terminal-bash/lib/index.js:900–969,1050–1053`. Windows dialect can be pwsh. |
| `dsh-tool-terminal` | Normal tools `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list`; registered through tools runtime (`lib/index.js:264,319,466,531,585,628`). Names reflect the actual registrations; terminal handles are not tmux session names. |
| Experimental bundle | `P/dsh-experimental-terminal-bundle/cordis.patch.yml` installs isolated `terminals` group, terminal registry, platform-selected bash/pwsh backend and terminal tools. Does not install sidebar UI. |
| `dsh-api-terminal-controller` + sidebar | Separate **user-controlled** web PTY, session-owned `owners` map, retention and streaming. `TerminalController.create(agent,request,signal)`, `attach(agent,id,signal): RemoteStream<TerminalFrame,TerminalInput>`, `retain(sessionId,id,signal)`, `close(agent,id)`, etc. `P/dsh-api-terminal-controller/lib/types/{index,types}.d.ts`. |

The user controller explicitly documents creation “without Agent sandbox or approval restrictions” (`P/dsh-api-terminal-controller/lib/index.js:818`). Its spawn at `:982–998` invokes `agent.ctx` subprocess **directly**, using `[shell.path,...shell.args]`, current cwd and `DSH_SESSION_ID`; it does not call the normal tool pipeline or sandbox confinement. This is the privileged user path xc **must not use for agent operations**. Although it checks availability of `sandboxPolicy`, that is not enforcement on the actual spawn.

Can official sidebar run `ssh -t NaMILab tmux attach -t %3`? It renders an interactive shell, so a **user can type that command**. `TerminalCreateRequest` is exactly `{shellPath?:string,id:WebTerminalId,cols:number,rows:number}`: **no command/argv field**. Its attach uplink accepts `{type:'write',sequence,data}` and `{type:'resize',sequence,cols,rows}`; therefore a deliberate user-action integration could create a shell and write a command through this privileged UI channel, but this is not an arbitrary-command tab API. Global controller config supports `shell:{path,name,args}`, not a safe per-tab command override. A dedicated xc viewer/PTY is cleaner for per-pane attach, with explicit user intent and separate agent tools. `%3` is a pane target; verify desired tmux attach-session target semantics in implementation rather than treating pane ids as session ids.

## 8. What dsh-tmux-context actually does

`P/dsh-tmux-context/lib/types/index.d.ts` / `lib/index.js` export `name = 'tmux-context'`, `inject = ['agents','sessionProjections']`, Schemastery `Config` with optional refresh interval, `apply`.

The final `lib/types/index.js` region of `lib/index.js` is the relevant plugin code (the preceding bundled LLM code is unrelated). On `agent/pre-step`, only first request of a turn (`step === 1`), after accepted downstream decision, it obtains optional `ctx.shell`, queries the **current process's** inherited `$TMUX_PANE`, and compares `tmux #{pane_tty}` with `ps -o tty= -p process.pid`. An inherited-only tmux environment, missing shell, or failed query injects nothing. It reads session name, window index/name, pane index/id, active flags and `window_layout`; changed state becomes a source-attributed `UserMessage` `{kind:'tmux-context',form:'snapshot',sections:[...]}`. A session projection tracks previous injection and refresh interval to avoid repeated identical state, including after reload/compaction.

It does **not** enumerate remote hosts, SSH, globally manage tmux sessions, capture arbitrary panes, expose manager tools, or add a client sidebar. It supplies current-location context only.

## 9. Hot reload: actual watch boundaries

| Path / trigger | Current behavior |
|---|---|
| Base profile | `P/dsh-base/cordis.patch.yml:27–32` mounts HMR only with profileContext and sets **`root: []`**. Thus ordinary source-module watching is opt-in even though Hmr class schema defaults root to `['.']`. |
| Host module watch | `P/dsh-hmr/lib/index.js:703–711,782–788,880–910`: `base`, `root`, `ignored`, debounce; default ignored includes `**/node_modules`, `**/.*`, `cache`, `data`. Requires loader internals (`--expose-internals` / compatible launcher). Changes can replace dependent plugin entries or require restart for host-owned dependency boundaries. |
| Profile config | HMR explicitly watches profile `package.json`, profile `cordis.patch.yml`, home `cordis.patch.yml`, even with empty module roots. Manifest refresh is gated by changed bundle list. `lib/index.js:827–875`. It is not a general watcher on every bundle source/patch. |
| Profile-installed code on reconciliation | `profileRoots(dir)` includes real profile dir plus direct/scoped symlink package targets (`:1449–1452`). `reconcileProfile()` compares **loaded files** under these roots, including normal installed files in profile node_modules (`:1308–1346`), then replaces eligible stale modules. This is a reconciliation-triggered disk comparison, not continuous node_modules source watch. |
| Client bundle | `P/dsh-client-hmr/lib/index.js` stat-polls **every advertised client graph row's built artifact** at default `pollIntervalMs:500`; compares mtime/ctime/size, calls `clientModules.rebuilt(id)`, serves `/plugins/events` SSE `graph` / `rebuilt`. No node_modules exclusion here. Browser disposes/re-materializes affected client entries through module-loader graph. |

Therefore: a plugin installed in profile node_modules can receive **client artifact** HMR when `dsh-client-hmr` is composed; arbitrary host `.js` edits there are **not automatically watched** by the default base profile. Host code can be compared on profile reconciliation, or an explicit suitable module-watch setup can be configured; some host changes still report restart required. TS/TSX source is never automatically built by these services. Old `dsh-tmux-cc` metadata is not evidence of current host live-reload behavior.

## 10. Cross-platform ssh subprocess with abort

Preferred host lifecycle seam is `ctx.subprocess: SubprocessRuntime` from `@deepseek-ai/dsh-subprocess`; implementation `LocalSubprocessRuntime` / default in `@deepseek-ai/dsh-subprocess-local`. Use explicit argv, not a bash wrapper, for host Windows OpenSSH. Relevant exact declarations:

```ts
// P/dsh-subprocess/lib/types/index.d.ts
resolveExecutable(command: string, env?: Readonly<Record<string,string>>, signal?: AbortSignal): Promise<string>;
spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>;
// P/dsh-subprocess/lib/types/types.d.ts
interface SubprocessSpawnSpec {
  argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number;
  signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv | undefined;
}
interface SubprocessStdio {
  stdin: 'ignore' | 'pipe' | { readonly data:string };
  stdout: 'pipe' | 'inherit' | SubprocessCollect;
  stderr: 'pipe' | 'inherit' | SubprocessCollect;
  control?: 'pipe';
}
interface SubprocessCollect { maxBytes:number; spill?:{maxBytes:number}; }
// handle: stdin/stdout/stderr/control, collected.stdout/stderr.readFrom(byteOffset),
// done:Promise<{exitCode:number|null,signal:NodeJS.Signals|null}>,
// terminate():void, waitForExit(signal?:AbortSignal):Promise<boolean>.
```

Proposed process plumbing (must be called **after** tool policy grants; this code itself is not approval or sandbox enforcement):

```js
const runtime = agent.ctx.get('subprocess');
const cwd = await agent.ctx.workingDirectory.ensure(agent, exec.signal);
const ssh = await runtime.resolveExecutable('ssh', undefined, exec.signal);
const child = runtime.spawn({
  argv: [ssh, '-T', '-o', 'BatchMode=yes', hostAlias, remoteCommand],
  cwd, signal: exec.signal, graceMs: 1000,
  stdio: { stdin: 'ignore', stdout: {maxBytes: 1048576}, stderr: {maxBytes: 262144} },
});
const outcome = await child.done;
// Inspect exitCode/signal and collected output; retain truncated/lossy facts.
```

`remoteCommand` needs a correctly encoded/quoted **remote shell** command despite local argv safety; host alias must come from configured trusted host identity, not arbitrary model-provided SSH options. For noninteractive tmux control use non-PTY SSH; user attach uses a PTY (`spawnTerminal`) and interactive SSH separately. Do not assume local AbortSignal proves remote tmux action was cancelled: SSH disconnect can leave already-issued remote effects. Capture and report actual outcome.

`LocalSubprocessRuntime.resolveExecutable` accepts absolute executable or bare PATH name, rejects relative slash paths, applies Windows case-insensitive environment lookup and PATHEXT (`P/dsh-subprocess-local/lib/index.js:1523–1547,1687`). Windows OpenSSH therefore works when `ssh.exe` is on PATH or supplied as an absolute configured path; no hardcoded Linux path or undocumented automatic OpenSSH location fallback is established. Local implementation selects managed Linux scope / Windows Job containment where supported, otherwise provider-owned termination fallback; POSIX TERM→KILL, Windows termination uses its platform owner (`lib/index.js:1549–1605`; `lib/types/spawn.d.ts`). Caller signal is forwarded into spawn, and caller must await settlement; `waitForExit` cancellation alone is not the spawn cancellation contract.

`dsh-win32-process` exports low-level `loadWin32ProcessBindings`, `spawnCurrentTokenJobProcess`, `spawnInheritedJobProcess`, `spawnPipedProcess`, `terminateJob`, `waitForProcessExit`, etc. (`P/dsh-win32-process/lib/types/index.d.ts`); these are platform internals, not the plugin's first-choice API.

`dsh-shell-env`: `ctx.shellEnv.register(contributor:BashEnvContributor):()=>void`, `collect(execution:ToolExecution):DshEnvironment`, where contributors declare/resolve `DSH_*` variables (`P/dsh-shell-env/lib/types/index.d.ts`). It does not resolve SSH or supply sandbox approval. Subprocess base environment is scrubbed by `scrubbedParentEnv()`; explicitly supplied environment merges using platform key semantics (`P/dsh-subprocess/lib/types/index.d.ts`; `P/dsh-subprocess-local/lib/types/spawn.d.ts`, `childEnv`). Preserve SSH_AUTH_SOCK/PATH as needed through actual environment handling; do not log credentials.

`dsh-launch-environment` records provenance: `launchEnvironmentOf(ctx): LaunchEnvironmentSnapshot`, `launchedThroughSsh(snapshot): boolean`, snapshot `get(name)` / `getFrom(name,sources)`, source `'process'|'project-env'|'user-env'` (`P/dsh-launch-environment/lib/types/index.d.ts`). It detects how DSH was launched; it is not a remote-host connector or process spawn service.

## Example-plugin evidence and remaining limits

- `/mnt/data2/weizhiwei/dsh-autoctx/{package.json,cordis.patch.yml,index.js,client.js}` demonstrates package roles, config schema, settings form bridge, React slot registration and document-relative fetch. Its custom routes and fallbacks should not be assumed to be recommended authentication patterns.
- `research/upstream/dsh-tmux-cc-0.6.0/package/{package.json,cordis.patch.yml,lib/client.js,dist/index.js}` demonstrates a shipped host/client tmux package. Its client injects old `dsh-client-runtime` and uses DOM/layout/custom transport patterns; do not substitute those for the verified current APIs above.
- `/mnt/data2/weizhiwei/deepseekbot/pr-work/tools/{h-ref-send.mjs,h-check.mjs}` are **browser automation**, not DSH reference-provider APIs. They click `.bh-generated-file-reference`, inspect `aria-pressed`, then type/send into `.bh-chat-layout` textarea/contenteditable. They demonstrate bot-specific UI interaction; no native DSH composer extension contract follows from them. They were read, not executed.
- Missing standalone `ui-slots`/runtime packages prevent citing a local complete `SlotCore.register` overload from those packages. The current renderer explicitly exports `SlotRegistry.register: SlotCore['register']`, and shipped sidebar implementation establishes the concrete supported call shape above. No unverified old runtime getter is needed.
- All findings are static source evidence. No assertion here means this installed profile was mounted or a live tmux/SSH operation succeeded. The implementation-critical gaps are explicit: custom token/history renderer, deterministic post-compaction reference index, new-tool action policy, and cross-process registry ownership if multiple hosts share one file.
