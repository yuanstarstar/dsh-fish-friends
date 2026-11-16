# DSH 会话（Session）API 研究报告

> 研究对象：DeepSeek Harness Desktop 已安装产物（只读，未改任何源码）
> 版本：全部 `@deepseek-ai/*` 包均为 `0.2.1-rc.2`
> 安装根：`C:\Program Files\DSH Desktop\resources\app\`
> 研究日期：2026-11-16

## 0. 路径约定

下文所有证据路径以 `ROOT` 为前缀：

```
ROOT = C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai
```

即 `ROOT\dsh-session\lib\index.js:1739` 表示
`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-session\lib\index.js` 第 1739 行。

另外：这些包**没有发布 `.d.ts`**，只有编译后的 ESM JS + README。因此下文的签名全部来自 JS 实现与 README 文档，而不是类型声明。README（`README.zh.md`）本身写得很完整，且与实现一致，是可靠的公开契约来源。

---

## 1. 结论摘要

| # | 问题 | 结论 | 关键 API |
|---|------|------|----------|
| 1 | session 用什么标识 | `session-<uuid v4>`（品牌字符串 `SessionId`） | `brandString(\`session-${randomUUID()}\`)` |
| 2 | host 插件能否列出会话 | **能**（三档：控制器 / 查询引擎 / 内存表） | `ctx.sessionController.list()`、`ctx.sessionQuery.filterSessions()`、`ctx.sessions.list()` |
| 3 | host 能否创建会话 | **能** | `ctx.sessionController.create({workspaceId\|cwd, sessionId?, agentPreset?})` |
| 4 | host 能否"切换当前会话" | **不能**——host 端没有"当前会话"这个概念，选择状态只存在于 Web 客户端 | —（见 §3.2） |
| 5 | host 能否向某会话发消息 | **能** | `ctx.sessionController.prompt({sessionId, requestId, content, mode?}, signal)` |
| 6 | web 客户端插件能否跳到某个会话 | **能**，且是唯一正确的做法 | `ctx.uiWorkspace.openSession(sessionId)` |
| 7 | 有没有 URL 路由（`/?session=xxx`） | **没有找到**。全客户端 bundle 无 `pushState` / `popstate` / `location.hash` | — |
| 8 | `dsh-tool-session-query` 暴露什么 | 不是 action 分发，而是 **5 个独立工具**，全部返回纯文本 | `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` |

一句话结论：

> **"创建会话"和"发消息"在 host 侧是公开 API；"切换/激活会话"在 host 侧不存在，只能由 web 客户端插件调用
> `ctx.uiWorkspace.openSession(sessionId)` 完成——这也正是侧栏点击会话行时走的同一条路径。**

---

## 2. 证据清单

### 2.1 Session 标识格式 = `session-<uuid>`

`ROOT\dsh-api-session-controller\lib\index.js:509`

```js
return this.createAgent(brandString(`session-${randomUUID()}`), cwd, composition);
```

同文件 L10 导入：`import { randomUUID } from "node:crypto"`；分叉子会话同样生成（L879）：

```js
const childId = brandString(`session-${randomUUID()}`);
```

内存表在**没有显式 id** 时的兜底命名（仅测试/内部路径）——
`ROOT\dsh-session\lib\index.js:1802`：

```js
sessionId = brandString(`session-${++this.counter}`);
```

紧接着 `while (this.store.has(sessionId))` 递增，L1805 冲突时抛
`session "${sessionId}" already exists`。品牌构造函数在同文件 L13（`SessionId(id)`）。

本会话自身的 id 即为 `session-9d134eed-e9e2-4611-b334-ec7594e3989a`，与格式一致。

**结论**：可用 `/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` 做基本校验；但不要把校验当权威，权威判断用 `list()` 是否包含该 id。

---

### 2.2 `ctx.sessions` —— 内存会话表（只能列"活着"的）

`ROOT\dsh-session\lib\index.js:1739`

```js
super(ctx, "sessions");
```

同文件 L1706 的文档注释把边界说得很清楚：

> In-memory session store (`ctx.sessions`). Persistence is intentionally not implemented here —
> the agent lifecycle attaches a session-log writer

方法全集（同文件，逐行抓取）：

| 方法 | 签名 |
|------|------|
| `create` | `create(id, options)` |
| `prepare` | `prepare(id, options)` |
| `enter` | `enter(session)` |
| `detachEntered` | `detachEntered(entry)` |
| `announce` | `announce(session)` |
| `emitDisposed` | `emitDisposed(entry)` |
| `liveEntryFor` | `liveEntryFor(session)` |
| `get` | `get(id)` |
| `list` | `list()` |
| `fork` | `fork(source, boundary, childSessionId)` |

`fork` 在 L2006 抛 `new SessionForkError(... "SESSION_ALREADY_EXISTS")`，L2012
`return this.create(childSessionId, {...})`。

导出（L2052）：`SessionStore as default`、`SessionStore`、`Session`、`SessionForkError`、
`KNOWN_SESSION_EVENT_TYPES`、`SESSION_FORMAT_VERSION`。

构造函数还注册了 typert 解析器（便于把 sessionId 解析成对象）：

```js
lookups.register("session", {
  parameter: "session", wire: "sessionId", resource: "session",
  resolve: (sessionId) => this.get(sessionId)
})
```

**限制**：`ctx.sessions.list()` 只返回**当前进程内已挂载**的会话；冷会话（历史里存在但没被 resume 的）不在其中。要列全部可见会话请用 §2.4 的控制器。

---

### 2.3 `ctx.sessionQuery` —— 只读查询引擎（不激活会话）

`ROOT\dsh-session-query\lib\index.js:1048`

```js
super(ctx, "sessionQuery");
```

类名 `SessionQueryEngine`，导出在 L1242（`SessionQueryEngine as default`）。

方法（同文件）：

| 方法 | 行号 |
|------|------|
| `readSession(sessionId)` | 1081 |
| `filterSessions(filters, signal)` | 1096 |
| `readTitle(sessionId, signal)` | 1106 |
| `readTitleSnapshot` | 1115 |
| `readTitleSnapshots(sessionIds, signal)` | 1129 |
| `listEvents(sessionId)` | 1143 |
| `filterEvents(sessionId, filters)` | 1152 |
| `readSurface(sessionId)` | 1168 |
| `traceSession(sessionId, signal)` | 1184 |
| `traceEvent(request, signal)` | 1196 |
| `readEvent(request, signal)` | 1210 |

`observeSession(...)` 也存在，被控制器使用（`ROOT\dsh-api-session-controller\lib\index.js:864`）：

```js
observed = await this.ctx.sessionQuery.observeSession(request.sessionId);
```

底层辅助：`listSessions(signal)` L95、`load(sessionId, signal)` L128、`projectMany(...)` L168、
`read(sessionId, options)` L350、`statSource` L399、`loadSource` L413。

**要点**：查询引擎是纯读，**不会** resume Agent、也**不会**改变任何 UI 选择。
另外它是**唯一**能批量取标题的入口（`controller.list()` 返回的行里没有 title）：
`readTitleSnapshots(ids, signal)` 一次拿多个标题，比逐个 `readTitle` 省往返。

---

### 2.4 `ctx.sessionController` —— 会话控制器（列表 / 创建 / 发消息 / 改名 / 分叉）

注册与导出：

`ROOT\dsh-api-session-controller\lib\index.js:2952`

```js
super(ctx, "sessionController", { namespace: "session" });
```

同文件 L3367 导出：

```js
export { ApiSessionNotFound, SessionController, SessionController as default,
         SessionFileReferences, SessionSkillCatalog, buildModelCatalog };
```

README 的定位（`ROOT\dsh-api-session-controller\README.zh.md:13`）：

> 拥有 Host 的 `ctx.sessionController` 服务，以及生成的 Client `session`、`skills` 和
> `fileReferences` Remote namespace

方法总表（同一文件）：

| 方法 | 行号 | 用途 |
|------|------|------|
| `list(_request, signal)` | 3061 | 列全部可见会话，**不** resume Agent |
| `search(request, signal)` | 3075 | 内容搜索（有界） |
| `create(request)` | 3090 | 新建/复用空白会话 |
| `selectModel(request)` | 3098 | 选模型 |
| `initializeDefaultModel()` | 3105 | |
| `modelCatalog()` | 3121 | |
| `canOpenWorkspacePath()` | 3128 | |
| `workspaceDesktop()` | 3135 | |
| `openWorkspacePath(request, signal)` | 3150 | |
| `workspacePathApplications(request)` | 3170 | |
| `verifyDesktopPath(path)` | 3181 | |
| `rename(request)` | 3196 | |
| `fork(request)` | 3206 | |
| `prompt(request, signal)` | 3218 | **发消息** |
| `attachment(request)` | 3237 | |
| `updateQueue(request)` | 3245 | |
| `cancel(request)` | 3253 | |
| `page(request, signal)` | 3262 | |
| `follow(request, signal)` | 3272 | 订阅投影 |
| `projections(request, signal)` | 3281 | |
| `liveProjections(sessionId)` | 3323 | |
| `inspect(sessionId, signal)` | 3046 | |
| `resolveAgent(sessionId)` | 3037 | 内部：按 id 取 live agent |

#### (a) 列会话

```js
// ROOT\dsh-api-session-controller\lib\index.js:3061
async list(_request, signal) {
  return { items: (await this.listState.list(signal)).filter((item) =>
    this.ctx.remoteAccess.allows({ kind: "session", id: item.sessionId })) };
}
```

注释原文：*"Read all visible Session rows without resuming an Agent."*
`search` 同理（L3075），返回 `{...result, items: result.items.filter(allows)}`。

真正的实现是内部的 `ApiSessionList.list(signal)`（同文件 L1959）：

```js
async list(signal) {
  const records = await this.ctx.sessionQuery.listSessions(signal);   // 全部持久化会话
  for (const record of records) {
    const live = this.ctx.sessions.get(record.header.id);
    if (live !== void 0) items.push(this.summaryFor(live));           // 活着的：带运行态
    else if (record.header.cwd !== void 0) cold.push(record);         // 冷的：也能列出来
  }
  for (const record of cold) items.push(this.summarizeCold(record));
  items.sort((l, r) => r.updatedAt - l.updatedAt);                    // 按活动时间倒序
  return items;
}
```

**每一行的真实字段**（`summaryFor` L1940 / `summarizeCold` L1990 / `listFields` L2127）：

```ts
{
  sessionId: string,        // 主键
  updatedAt: number,        // 毫秒时间戳，排序依据
  agentAvailable: boolean,  // 是否已挂载 live Agent
  formatStatus?: string,    // 仅冷会话/有版本差异时出现
  running: boolean,
  blank: boolean,           // 空会话（可被 create 复用）
  parentSessionId?: string, // 有父会话时
  origin?: string,
  cwd?: string,
  projections?: { values: { ... } }   // 投影缓存（含 sessionListMetadata 等）
}
```

> ⚠️ **没有 `title` 字段**。`list()` 只给 header + 投影缓存，标题要另外读：
> `ctx.sessionQuery.readTitle(id, signal)`（L1106）或批量的
> `readTitleSnapshots(ids, signal)`（L1129）。

→ host 插件可以这样用：

```js
const { items } = await ctx.sessionController.list({}, ctx.lifetime.signal);
const id = items[0].sessionId;
const title = await ctx.sessionQuery.readTitle(id, ctx.lifetime.signal);
```

#### (b) 创建会话

`ROOT\dsh-api-session-controller\lib\index.js:755-787`

```js
// 请求：{ workspaceId?, cwd?, sessionId?, agentPreset? }
throw new RemoteError("gateway/bad-request",
  "session.create accepts workspaceId or cwd, not both", {});   // L756
const workspace = this.ctx.workspaceRegistry.get(request.workspaceId);
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;
await this.agents.createSession({ ...sessionId, cwd, ...agentPreset,
  reusable: (id) => !archivedSessionIds.includes(id) &&
                    (workspace === void 0 || workspace.sessionIds.includes(id)) });
await workspace.attachSession(sessionId);      // 失败 → "session/workspace-attach-failed"
// 返回 { sessionId, agentPreset? }
```

README 的设计约束（`ROOT\dsh-api-session-controller\README.zh.md:34`）补充了复用规则：

> list 只读已持久化的 header 与投影缓存行，绝不打冷会话正文；
> 只有 create 与 fork 会直接创建新 Agent；
> create 只在"空白 + 同 cwd + 未归档 + 未被写锁占用"时复用指定 id。

#### (c) 向会话发消息

远程侧（L3218-3235）校验后转内部实现：

```js
// 校验空内容
RemoteError("gateway/bad-request", "prompt content must include non-whitespace text or an attachment")
// 校验时区
"session/invalid-time-zone" → "clientTimeZone must be UTC or a valid IANA Area/Location name"
// 构造来源
{ kind: "user", rpcId: request.requestId, clientTimeZone?, principal? /* principalOf(this.ctx.invocation) */ }
```

内部实现（L925 起）：

```js
async prompt(request, source) {
  const agent = await this.resolveAgent(request.sessionId);
  if (hasPromptRequest(agent, request.requestId)) return { accepted: true };  // 幂等去重
  ...
  if (request.mode === "steer") agent.steer(message);
  else                          agent.followup(message);
  return { accepted: true };
}
```

错误码：`"session/not-found"`（`session "${agent.id}" was disposed during prompt admission`）、
`"session/attachment-invalid"`、`"session/agent-busy"`（`prompt rejected`）。

→ 调用样例（host 插件；`requestId` 必须自己生成且唯一，重试沿用同一个即可幂等）：

```js
const res = await ctx.sessionController.prompt({
  sessionId: "session-....",
  requestId: crypto.randomUUID(),
  content: [{ type: "text", text: "来自插件的一条消息" }],
  // mode: "steer"   // 可选：插入到当前回合；默认 followup 排队
}, ctx.lifetime.signal);
// res === { accepted: true }
```

#### (d) 改名 / 分叉

- `rename(request)` = `{ sessionId, title }`，错误 `"session/title-invalid"`。
- `fork(request)` = `{ sessionId, atSeq?, allowMigration? }` → `{ sessionId: childId }`；
  无已完成的回合时 `"session/fork-unavailable"`，消息
  `session "${request.sessionId}" has no completed turn to fork from`。
- 其它错误：`"session/conflict"`、`"session/writer-held"`、`"session/migration-required"`、
  `"session/model-unavailable"`、`"session/projections-unavailable"`、
  `"session/steer-unavailable"`、`"session/queue-item-not-found"`、
  `gateway/bad-request`、`gateway/internal`、`workspace/not-found`、`subagent/unauthorized`。

---

### 2.5 `ctx.agents` —— 更底层（工厂层）

`ROOT\dsh-agent\lib\index.js:332`

```js
super(ctx, "agents");
```

方法：`currentInitiator()`、`requireInitiator()`、`withInitiator(agent, operation)`、
`withoutInitiator(operation)`、`setFactory(factory)`、`requireFactory()`、
`async create(options)`（L453）、`async resume(options)`（L466）、`register(agent)`、
`enter(agent, owner)`、`detachEntered(entry)`、`emitDisposed(entry)`、
`announce(agent, source, signal)`、`get(id)`、`isOwnedBy(id, owner)`、`list()`、`roots()`、
`closeInitiators()`、`disposeInitiators()`、`runWithInitiator(agent, operation)`、
`hasLifecycleAncestor(candidate)`、`assertInitiatorsReadable()`。

```js
// L453
async create(options) {
  const ownerCtx = this.ctx;
  const { target } = this.requireFactory();
  const receiver = getTraceable(ownerCtx, target);
  return Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);
}
```

**建议**：这是内部工厂入口，参数随 agent-loop 实现变动；普通插件请用 §2.4 的
`sessionController.create()`。

---

### 2.6 Web 客户端：真正"切换会话"的调用链

#### (a) 公开文档化的服务方法

`ROOT\dsh-client-ui-workspace\README.zh.md:74`（原文）：

> `ctx.uiWorkspace.openSession(target)` 会同步替换其拥有的 `mainView` reference，并让主区域返回
> Conversation，而不等待 `reference.ready`，因此历史加载会显示在已经选中的 Session 视图内。
> 目标可以是已知 Session id，也可以是持久的直接父子 subagent 地址；显式地址不要求预先加载
> parent catalog。`openWorkspace(id, beforeOpen?, options?)` 仅在请求未被后续导航替代时打开工作区
> 空白 Session；显式新会话操作会创建新的 Session。`forkSession(id)` 创建子会话，不导航，也不替代
> 尚未完成的导航。

→ **这是本报告最重要的一条**：`openSession` 是被 README 明确写成公开 API 的，不是内部函数。

#### (b) 服务实现

`ROOT\dsh-client-ui-workspace\lib\client.js:1379-1396`

```js
constructor(ctx, directoryPicker, workspaces, sessions, view, notify) {
  super(ctx, "uiWorkspace");
  ...
}
```

`ROOT\dsh-client-ui-workspace\lib\client.js:1470-1472`

```js
openSession(target) {
  this.replaceMain(target, this.lifetime.signal, "reveal");
}
```

`replaceMain`（L1651-1674）——真正的"激活"语义：

```js
signal.throwIfAborted();
const reference = this.sessions.retain(target, { source: "mainView" });   // 关键：mainView 保留位
beforeOpen?.(reference.sessionId);
this.selection.set({ sessionId: reference.sessionId, ...subagentAddress }); // 写入"当前会话"
// 释放旧 mainReference
if (panel === "reveal") this.ctx.layout.selectPanel(null);                // null = 回会话界面
```

也就是说：**"当前会话"的定义就是"被 mainView 这个 source retain 的那一行"**
（`ROOT\dsh-client-ui-workspace\lib\client.js:89`）：

```js
const current = () => Object.values(ctx.sessions.list.getSnapshot().byId)
  .find((row) => (row.retainedBy.mainView ?? 0) > 0);
```

#### (c) 其它导航方法

| 方法 | 行号 | 行为 |
|------|------|------|
| `startSession(workspaceId, options)` | 1499-1527 | 新建（或复用空白）会话并打开；`options = {prompt?, clearPreviousDraft?, agentPreset?}` |
| `openWorkspace(workspaceId, beforeOpen, options={})` | 1473 | 打开工作区的空白会话 |
| `openWorkspaceSession(...)` | 1476-1490 | `AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])` → 提交导航 |
| `connectWorkspace(workspaceId, options)` | 1397 | 连到工作区（`connectBlank` L1403-1417，内部 `this.sessions.create({workspaceId})` L1406） |
| `createNamed(request)` | 1436 | `const sessionId = await this.sessions.create(request);` |
| `forkSession(sessionId, onCreated, options)` | 1491-1498 | 建子会话，**不导航** |
| `clearMain()` | 1644-1650 | `this.selection.set({}); previous?.release(); this.ctx.layout.selectPanel(null);` |

#### (d) 侧栏点击会话行 = 调用 `openSession`

`ROOT\dsh-client-ui-workspace\lib\client.js:5063-5065`

```js
const openSession = (sessionId) => {
  uiWorkspace.openSession(sessionId);
};
```

（同文件还有 L5172 `uiWorkspace.openSession(sessionId)`、L5140
`uiWorkspace.forkSession(sessionId, (childId) => {...})`、L5183
`uiWorkspace.startSession(workspaceId, options)`。）

侧栏侧：`ROOT\dsh-client-ui-sidebar\lib\client.js:448`

```js
const workspaceNavigation = ctx.get("uiWorkspace");
```

L473-475：

```js
const injectProps = () => ({
  startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId); },
  toggleSidebar: () => { ctx.layout.toggleSidebar(); ... }
});
```

L481 `ctx.layout.selectPanel(id)`；"新建会话"按钮走 `startSession()`
（`ROOT\dsh-client-ui-sidebar\lib\client.js:68`、L343、L361；
`SidebarRoot({... startSession, toggleSidebar, selectPanel ...})` L207，
`HeaderLeadingControls({toggleSidebar, startSession, ...})` L38）。

#### (e) 客户端 `sessions` 服务是"引用/保留"，不是导航

`ROOT\dsh-api-session-controller\lib\client.js:3840`

```js
rootCtx.reflect.provide("sessions", this, void 0);
```

契约见 `ROOT\dsh-api-session-controller\README.zh.md:80`：

- `sessions.retain(target, { source, signal? })` → 引用，`release()` / `Symbol.dispose` 幂等，带 `ready` Promise
- `sessions.using(target, options, operation)` → 回调期间持有引用
- `binding(id)` / `scope(id)` → 仅借用已存在的 generation
- `retainInfo(id)` → 不产生 I/O 的来源计数
- `sessions.subagentAddress(sessionId)`（ui-workspace L1661 用到）

**结论**：想"跳过去"要用 `uiWorkspace.openSession`，`sessions` 服务不负责导航。

#### (f) 选择状态持久化在 localStorage

`ROOT\dsh-client-ui-workspace\lib\client.js:1369`

```js
selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } });
```

key = `dsh.sessions.current`，值形如 `{ sessionId, subagentAddress? }`。
启动恢复：`watchNavigation()` L1574-1604 + `restoreSelection(workspaces, sessions)` L1605-1628。

#### (g) 没有 URL 路由

对 `ROOT\*\lib\client.js` 全量 grep `pushState|replaceState|location\.hash|popstate`：

```
NO pushState/hash/popstate in any lib/client.js
```

（`ROOT\dsh-client-ui-conversation\lib\client.js` 里只有词法编辑器用的 `URLSearchParams`：
L5292、L12450、L12869、L13282、L13818，与本主题无关。）

→ **`/?session=xxx` 这种深链不存在**，也没有 `ctx.router` / `ctx.navigate`。
刷新后靠 localStorage 恢复，不能靠 URL 分享。

#### (h) `ctx.layout` 只能换面板，不能换会话

`ROOT\dsh-client-ui-layout\README.zh.md:32`：

> `ctx.layout.selectPanel(id)` 选中已注册面板，`null` 则选中会话界面，但不改变当前会话

另：`toggleSidebar()`、`openRightbar(track, fullscreen)`、`closeRightbar()`；
README L57 —— `beginNavigation()` 返回用于异步 UI 导航的 abort signal：

> 后续调用、有效面板选择（包括重复选择）或布局释放会中止该 signal，但不取消底层会话创建

---

### 2.7 `dsh-tool-session-query`：5 个工具（不是 action 分发）

实现：`ROOT\dsh-tool-session-query\lib\index.js`，注册在 L948-1021。

| 工具名 | 行号 | 说明 |
|--------|------|------|
| `session_search` | 956 | 在调用者工作区内搜历史会话，每个会话返回最强匹配事件 |
| `session_event_search` | 965 | 在**单个**已授权会话内搜事件；当前会话排除"正在执行本调用的这一步" |
| `session_trace` | 974 | 会话谱系（祖先/后代） |
| `session_event_trace` | 983 | 单个事件的替换链/来源链 |
| `session_event_read` | 998 | 读某个 seq 附近的原始事件 |

参数（zod schema，同文件）：

`session_search`（`toolInput.sessionSearchParameters`，L14-83）：

```ts
{
  query: string,                       // 必填
  session_ids?: string[],
  created_at_from?, created_at_to?,
  parent_session_ids?: string[],
  include_root_sessions?: boolean,
  availability?: ("live" | "persisted")[],
  event_seq_from?, event_seq_to?: integer,
  event_time_from?, event_time_to?,
  event_types?: string[],
  event_surfaces?: ("current" | "shadowed" | "log-only")[]
}
```

`session_event_search`（L84-127）：`{ session_id?(省略=当前会话), query(必填), seq_from?, seq_to?,
time_from?, time_to?, event_types?, surfaces? }`

`session_trace`（L128-131）：`{ session_id? }` —— 注释 *"Target session id. Omit for the current session."*

`session_event_trace`：`{ session_id?, seq }`（seq 必填整数）

`session_event_read`：`{ session_id?, seq(必填), before?, after? }`（前后各读多少条原始事件）

公共配置：`output: TEXT_OUTPUT`（**纯文本，不是 JSON**）、`timeoutMs: resolved.searchTimeoutMs`；
`maxSearchResults` 默认 100，`searchTimeoutMs` 默认 `3e4`；
校验 L1023-1032 抛 `tool-session-query: maxSearchResults must be a positive safe integer` /
`searchTimeoutMs must be a positive integer no greater than ...`；
导出 L1034 `{ Config, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_TIMEOUT_MS, apply, inject, name }`。

返回文本格式（L597-660）：

```
Session search results (2):

1. Session session-xxxx — 标题
   Created: 2026-11-16T...
   Parent: root | <parentId> | [outside workspace]
   Availability: live, persisted
   Best match: seq 42 | user | current | 2026-11-16T...
   Snippet: ...
```

- 空结果：`No prior session matches found.`
- 截断：`Result cap reached. Narrow the query or add filters to find additional matches.`
- 事件搜索：`Session <id> — <title>` + `Event search results (N):` + `1. seq N | type | surface | time` + `   Snippet:`
- trace：`Session <id> — <title>` / `Created:` / `Availability:` / `Ancestors (nearest first):` +
  `- none (target is a root session)` 或 `- [outside workspace boundary]` / `Descendants:`
- event trace：`Target: seq ... | type | surface | time` / `Replaced by:` / `Replacement chain:` /
  `Events replaced by target:` / `Events cited directly as sources:` / `Direct derived events:`

系统提示词片段（L946）说明用法：

> Use session_search ... or session_event_search ... cursor-free and workspace-scoped.
> Follow a useful hit with session_trace, session_event_trace, or session_event_read...

执行走 `ctx.sessionQuery.searchSessions(...)`（L777）+ 分页 `collectPages(maxResults, signal, request, accept)`（L881）。

**注意**：这 5 个是**给模型用的工具**，不是插件可直接调用的 API；插件应调
`ctx.sessionQuery.*`（§2.3）。

---

## 3. 可行方案

### 方案 A（推荐）：客户端 `ctx.uiWorkspace.openSession(sessionId)`

```js
// 第三方 client bundle 里
const ui = ctx.get("uiWorkspace");     // 或在 inject 里声明后直接用 ctx.uiWorkspace
ui.openSession("session-9d13...");     // 立即选中并切到会话界面
```

- 与侧栏点击**完全同一条路径**（`replaceMain` → `sessions.retain({source:"mainView"})` → `selection.set` → `selectPanel(null)`）。
- 目标可以是 sessionId，也可以是 subagent 地址（README L74）。
- 不等待 `reference.ready`，历史加载发生在已选中的视图内——UI 不会白屏，只是先空后有。
- 限制：
  1. **只在浏览器/客户端侧可用**。host 插件没有这个方法（host 没有 `uiWorkspace` 服务）。
  2. 依赖 `dsh-client-ui-workspace` 被加载（官方 Web GUI 默认如此）；插件最好 `ctx.get("uiWorkspace")` 判空降级。
  3. 不改变 Host 的任何状态；只是前端选择。

调用后想确认生效，可读
`ctx.get("sessions").list.getSnapshot().byId[id].retainedBy.mainView > 0`。

### 方案 B：host 端"后台投喂消息"，不切 UI

```js
await ctx.sessionController.prompt({
  sessionId, requestId: crypto.randomUUID(),
  content: [{ type: "text", text: "..." }]
}, signal);
```

- 适合"外部渠道（QQ/微信/直播间）来消息 → 写进某个会话"的场景。
- `requestId` 决定幂等：同一个 requestId 重复调用返回 `{accepted:true}` 而不会重复入队。
- `mode: "steer"` 插进当前回合，默认 `"followup"` 排队。
- 限制：
  1. **不会**把前端切到那个会话；用户可能完全不知道有新消息（除非你的客户端插件收到事件后自己 `openSession`）。
  2. 需要会话对当前调用方的 `remoteAccess` 可见（`allows({kind:"session", id})`）。
  3. 冷会话要先能被 `resolveAgent`（`"session/not-found"`）；写锁被占 → `"session/writer-held"`；agent 忙 → `"session/agent-busy"`。

### 方案 C：只存外部标识（当 A+B 都不适用时）

如果宿主是纯 host 插件（无 client 部分）且不能保证拿到会话：

- 自己维护 `{channel: "qq"|"bilibili"|..., channelUserId, sessionId, createdAt}` 映射表；
- 用户回来时手动点侧栏切换；
- 或者：host 侧建会话（`sessionController.create`）后把 sessionId 通过事件/存储交给你的 client 插件，
  由 client 插件在**用户可见时**调 `openSession`。

限制：这本质上是"存一个标识 + 让用户/客户端去跳"，不是真正的服务端激活。

### 明确不可行的做法（不要写进代码）

| 想法 | 结论 |
|------|------|
| `ctx.router.navigate(...)` / `ctx.navigate(...)` | **未找到**（全客户端 bundle 无此服务） |
| `window.location = "/?session=xxx"` | **未找到**任何 URL 路由；无 `pushState`/`popstate`/`location.hash`；刷新只靠 localStorage `dsh.sessions.current` |
| host 侧 `ctx.sessionController.activate/open/select(sessionId)` | **未找到**（控制器只有 create/fork/prompt/rename/...，没有"选中"概念） |
| `ctx.layout.selectPanel(sessionId)` | 参数是**面板 id**，不是会话 id；且 README 明说"不改变当前会话" |
| `ctx.sessions.fork(...)` 当作"切过去" | fork 只建子会话，不导航（README L74 明确"不导航"） |

---

## 4. 给插件作者的建议字段设计

### 4.1 存什么

```ts
type StoredSessionRef = {
  sessionId: string;        // 主键，形如 "session-<uuid>"；不要存标题当键（可改名）
  workspaceId?: string;     // 便于"回到同一工作区新建"
  cwd?: string;             // 会话可能属于别的工作区时的兜底定位
  titleSnapshot?: string;   // 仅用于展示；list() 不返回标题，需 sessionQuery.readTitle(s) 取，且随时可能被改名
  subagentAddress?: string; // 若指向 subagent，用 uiWorkspace 支持的地址形态
  createdAt?: string;       // ISO
  lastOpenedAt?: string;    // ISO，用于"最近会话"排序
  availability?: "live" | "persisted";  // 来自 session_search / list
};
```

外部渠道绑定（若做"QQ 好友 ↔ 会话"）：

```ts
type ChannelBinding = {
  channel: "qq" | "bilibili" | "webhook";
  channelUserId: string;
  sessionId: string;
  boundAt: string;
  // 可选：绑定时快照，便于失效时提示
  workspaceId?: string;
};
```

### 4.2 校验与容错顺序

1. 格式校验：`/^session-[0-9a-f-]{36}$/`（**只用于快速拒绝**，不当作存在性证明）。
2. 存在性/可见性校验：`ctx.sessionController.list({}, signal)` 的 `items` 里是否包含该 id
   （或 `items.find(i => i.sessionId === id)`）；host 侧还有 `remoteAccess.allows` 过滤。
3. 前端跳转前：`const ui = ctx.get("uiWorkspace"); if (!ui) → 降级（提示"请手动在侧栏打开"）`。
4. 跳转后：轮询/订阅 `ctx.get("sessions").list`，等
   `byId[id].retainedBy.mainView > 0` 再认为"已激活"。
5. 错误码分支至少覆盖：`"session/not-found"`、`"session/writer-held"`、`"session/agent-busy"`、
   `"session/conflict"`、`"session/migration-required"`、`"session/workspace-attach-failed"`。

### 4.3 声明注入的方式（第三方 bundle 现状）

现有第三方插件的写法（`%USERPROFILE%\Desktop\插件开发\dsh-meituan\client.js:389-391`）：

```js
inject: ['slots'],
apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ ... }));
}
```

本报告涉及的服务都可以用同一套机制拿到：

```js
inject: ['slots', 'uiWorkspace'],           // 或 'sessions' / 'layout'
apply(ctx) {
  // 或者惰性取，避免依赖顺序： ctx.get('uiWorkspace')
}
```

> 建议：**用 `ctx.get()` 惰性获取 + 判空降级**，而不是硬写进 `inject`——这样在
> `dsh-client-ui-workspace` 未加载的精简客户端里你的插件仍能启动。

### 4.4 一个最小的"打开会话"实现

```js
function openSessionBestEffort(ctx, sessionId) {
  const ui = ctx.get("uiWorkspace");
  if (ui && typeof ui.openSession === "function") {
    ui.openSession(sessionId);          // 真正切过去
    return true;
  }
  const sessions = ctx.get("sessions");
  if (sessions && typeof sessions.retain === "function") {
    // 退而求其次：只保证会话被激活/保留（不会切 UI）
    const ref = sessions.retain(sessionId, { source: "myPlugin" });
    ref.ready.finally(() => ref.release());
    return false;
  }
  return false;
}
```

---

## 5. 未找到 / 需要后续确认

| 项 | 状态 |
|----|------|
| `ctx.router` / `ctx.navigate` / `ctx.history` | **未找到**（不在任何 `lib/client.js` 的服务注册里） |
| URL 深链 `?session=` / `#session=` | **未找到**（无 `pushState`/`replaceState`/`location.hash`/`popstate`） |
| host 侧"激活/选中会话" API | **未找到**（控制器无此方法；选择状态属客户端） |
| `.d.ts` 类型声明 | 未发布（只有 JS + README），签名以本报告所引实现为准 |
| `dsh-client-ui-session` 包 | 存在，但**不是**导航实现点：它是 React 适配层——`ROOT\dsh-client-ui-session\README.zh.md:11` 明确写「它按 `SessionBinding` 物化钩子和 prop……但它不拥有 Controller transport、历史或 reference」；切换会话的实现点在 `dsh-client-ui-workspace` |

> 若后续 DSH 版本新增了 URL 路由或 `sessionController.activate`，本报告 §3 的"不可行"表需重新核对；
> 复核方式：`grep -r "pushState\|activate(" ROOT\*\lib\client.js` 与
> `grep -n "async [a-zA-Z]*(" ROOT\dsh-api-session-controller\lib\index.js`。
