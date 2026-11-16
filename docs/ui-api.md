# DSH 桌面版：客户端插件 + UI 插槽 + host HTTP 接口

> 研究对象：`C:\Program Files\DSH Desktop\resources\app\`（安装版，包在 `node_modules\@deepseek-ai\` 下）
> 目标：给 `dsh-fish-friends` 加一块「好友列表 / 朋友圈」的可视化面板，数据走 host 的 HTTP 接口。
> 本文只读研究结论，未改动任何源码。行号全部来自当前安装版本（`@deepseek-ai/dsh-client-*` 均为 `0.2.1-rc.2`，React `18.3.1`）。

---

## 0. 结论（先看这段）

| 问题 | 结论 |
| --- | --- |
| 面板该注册到哪个插槽？ | **`main`（kind=keyed，scope=root）+ `sidebar.panellist`（左侧栏图标入口）**。`main` 是全局面板区，`sidebar.panellist` 的 `id` 必须等于 `main` 的 `key`，点图标才会 `selectPanel(id)` 切到你的面板。 |
| 为什么不用 `settings.section`？ | 它是设置模态里的一「页」（内容区宽度有限、要点开关才能看到），适合小卡片，不适合全屏大面板。 |
| 客户端插件怎么写？ | 一个 **classic script**（不能有 ESM `import/export`），调用 `window.__ModuleLoader__.load({id, factory(require){...}})`；`factory` 返回 cordis 插件对象 `{name, inject, apply}`；组件用 `React.createElement`（`h()`），React 由宿主提供。 |
| `dsh.client` 三个字段 | `platform`：必须字符串且等于 `'web'`，否则这个包不进客户端模块图；`immediately`：boolean，只在启动时**预取**该 bundle（`prefetchImmediateTier`），不影响激活顺序；`inject`：`string[]` 平台包名，浏览器侧会**先递归加载**这些依赖行再加载自己。 |
| host 怎么暴露 HTTP？ | `export const inject = ['tools', 'webServer']`，然后 `ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-fish-friends/api', handler }), 'label')`；handler 签名 `async (req, res, next)`，自己判前缀、自己写 JSON 头。**没有鉴权层**。 |
| 改 `client.js` 怎么生效？ | **刷新页面即可，不用重启 DSH**。DSH 自带 `dsh-client-hmr`（500ms stat 轮询 + SSE `/plugins/events`），会自动替换；即使 HMR 不工作，F5 也能拿到新 bundle（URL 带 `?rev=`，服务端 `immutable` 缓存靠 rev 破）。**但**：改 `package.json`（`dsh.client` / `exports`）、新增插件、改 host 代码 → **必须重启 DSH**（host 侧 `pkgMeta` 缓存从不失效）。 |
| 当前 `dsh-fish-friends` 能直接看到 UI 吗？ | **不能**。`%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 和 `dependencies` 里都没有 `@local/dsh-fish-friends`，插件未被装载（`client.js` 也还不存在）。首次启用要 link + 加 bundles + 重启。 |

---

## 1. 插槽清单

### 1.1 插槽引擎的结构

- `@deepseek-ai/dsh-client-ui-slots` 是**纯核**（无 cordis 依赖）：`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-ui-slots\lib\index.js`
  - 构造时预置唯一的内建 slot：`'root'`（kind `single`，scope `root`，`declaredBy: "(built-in)"`，`:64-72`）。
  - `register(options, component)` `:163-243`、`entriesOfSlot`（遮蔽逻辑）`:278-293`、`snapshot(root)` 导出拓扑。
- cordis 服务层在同目录 `dsh-client-ui-renderer`：`...\@deepseek-ai\dsh-client-ui-renderer\lib\client.js:1304` `var SlotRegistry = class extends Service`，服务名 **`slots`**（`:1347` `super(ctx, "slots")`）。
- 四种 kind：

  | kind | 语义 | 必填 options |
  | --- | --- | --- |
  | `single` | 每个 `priority` 只能一份 | — |
  | `list` | 多条按 `(priority, order)` 排序渲染 | `id` |
  | `keyed` | 按 `key` 选一条渲染（同 key+priority 唯一） | `key` |
  | `chain` | 链式，由 `select` 决定谁渲染 | `select` |

- 每种 kind 的校验和报错原文在 `...\dsh-client-ui-slots\lib\index.js:165-193`：
  - 未声明：`slot "<name>" is not declared (a parent entry's children table must declare it)`
  - single 占用：`single slot "..." already has a registration at priority N (registered by ...) register at a different priority to shadow it (lowest renders)`
  - keyed 缺 key：`keyed slot "..." requires options.key`
  - list 缺 id：`list slot "..." requires options.id`
  - chain 缺 select：`chain slot "..." requires options.select`
  - 子 slot 重复声明：`slot "..." is already declared (by ...)`

### 1.2 `register(options, component)` 的 options 结构

`...\dsh-client-ui-slots\lib\index.js:204-219` 只保留这些字段：

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `name` | string | slot 名（必须已被声明） |
| `id` | string | list/keyed 必填（list 用来去重与排序） |
| `key` | string | keyed 必填（`main` 用它选面板） |
| `order` | number | list 内的次级排序（`:221` 先 `priority` 再 `order`） |
| `label` | string \| `() => string` | 导航/标签文字，支持 thunk（`resolveSlotLabel`，`:27`） |
| `priority` | number | 遮蔽机制（同 priority 冲突直接抛错；`lowest renders`） |
| `select` | fn | chain 必填 |
| `inject` | `() => object` | 返回对象**直接展开成组件 props**（渲染时求值：`renderer\lib\client.js:434-437`、`:1021` `runInject(...)`） |
| `children` | `{ [slotName]: spec }` | 声明子 slot（声明后别人才能 register） |
| `store` | handle | 绑 scope 的 store 句柄（跨 scope 复用抛 `one handle, one scope`） |
| `locale` | string | 命名空间，给 `t()` 用 |
| `registrant` | string | 审计用，默认 `ctx.fiber?.name`（`renderer\lib\client.js:1602-1622`） |

- 返回值是**幂等 disposer**（`:237-242`），会连带移除该 entry 声明的子 slot。
- 组件收到的 props = 五份 share 合并（`...\dsh-client-ui-slots\README.zh.md:36-38`）：runtime share（父 render 调用点的 owner props + 会话标准工具包）、`renderSlot`、`renderFactorySlot`、store share、**`inject` 推导的业务 share**；渲染时浅合并顺序是 `{...ownerProps, ...injected, ...slotInjected.props}`（`renderer\lib\client.js:786-796`）。

### 1.3 全量 slot 名（grep `name:"<slot>"` 去噪结果）

> 说明：包内 README **没有**给出完整清单，下表是扫描 `node_modules\@deepseek-ai\*\lib\client.js` 的注册/声明点得到的；「kind」列凡未读到声明点的都标 `?`，不要当契约用。

| slot | kind / scope | 用途 | 示例（文件:行号） |
| --- | --- | --- | --- |
| `root` | single / root | 应用根（内建） | `dsh-client-ui-layout\lib\client.js:623-653` |
| **`main`** | **keyed / root** | **全局面板区（`key` 选面板，`conversation` 是保留 key）** | `dsh-client-ui-layout\lib\client.js:623-653` 声明；`:119` `renderSlot("main", {}, {entryKey: activePanelId ?? "conversation"})` |
| `sidebar` | single / root | 左侧栏容器替换 | `dsh-client-ui-layout\lib\client.js:623-653` |
| `rightbar` | single / root | 右侧栏容器替换 | 同上 |
| `shell.bottom` / `shell.leading` | single / root | 框架底部条 / 前部条 | 同上 |
| **`shell.overlay`** | **list / root** | **覆盖整个框架的浮层（悬浮灯、通知）** | `dsh-client-ui-chat\lib\client.js:13288` |
| **`sidebar.panellist`** | **list** | **左侧栏图标入口（点它 `selectPanel(id)`）** | `dsh-client-ui-plugin-manager\lib\client.js:4522-4528` |
| `sidebar.footer.action` | ? | 侧栏底部按钮 | 仅见注册点；kind 未确认 |
| `sidebar.brand.mark` / `sidebar.brand.name` | ? | 品牌区图标 / 文字 | 仅见注册点 |
| `sidebar.settings` | ? | 侧栏设置入口 | 仅见注册点 |
| `sidebar.toggle.badge` | ? | 折叠按钮上的角标 | 仅见注册点 |
| `sidebar.workspaces` | ? | 工作区列表容器 | 仅见注册点 |
| `sidebar.workspaces.directoryFlow` | ? | 工作区「添加目录」流程 | 仅见注册点 |
| `sidebar.session.row.hover` / `.leading` | ? | 会话行的 hover 区 / 前置图标 | 仅见注册点 |
| `sidebar.workspaces.session.row.action` | list | 会话行右侧按钮 | 仅见注册点 |
| `sidebar.workspaces.session.menu.item` | list | 会话右键菜单项 | 仅见注册点 |
| `sidebar.chat.conversation` | ? | 侧栏里的会话列表 | 仅见注册点 |
| **`settings.section`** | **list / root** | **设置模态里的一「页」（导航行自动生成）** | 声明 `dsh-client-ui-settings-general\lib\client.js:1288-1291`；渲染 `:367` `renderSlot("settings.section", { close: onClose }, { only: active })`；导航行 `:1175-1185` |
| `settings.general.item` | list | 设置→通用里的条目行 | 仅见注册点（12 处） |
| `settings.header` / `settings.action` / `settings.close` / `settings.trigger` | ? | 设置模态的头/动作/关闭/触发 | 仅见注册点 |
| `settings.launcher` / `settings.onboarding` | ? | 设置里的启动器 / 引导页 | 仅见注册点 |
| `settings.models.sign-in` | ? | 模型登录区 | 仅见注册点 |
| `settings.plugins.tab` | list | 插件设置的标签页 | 仅见注册点 |
| **`sidebar.right.pane.tab`** | **keyed**（按 tabId） | **右侧停靠面标签页的正文**（两段式注册，见下） | `dsh-client-ui-sidebar-right\README.zh.md:83-84` |
| `sidebar.right.pane.tab.title` | ? | 右侧标签页标题 | 仅见注册点（7 处） |
| `sidebar.right.tab.document` | list | 右侧文档标签 | 仅见注册点（8 处） |
| `sidebar.right.tab.files.actions` / `.guide.entry` / `rightbar.session` | ? | 右侧文件动作 / 引导 / 会话 | 仅见注册点 |
| `plugins.tab` / `plugins.item` / `plugins.add.actions` / `plugins.bundle.activation` / `plugins.bundle.config` | list 等 | 插件管理页 | 仅见注册点 |
| `conversation.*`（`composer`、`content`、`chat.node`、`reasoning.body`、`user.content`、`hero.*`、`input.*` 等 ~30 个） | 多为 list/keyed | 会话区细粒度扩展点 | 仅见注册点（`conversation.chat.node` 19 处） |
| `tool.call.toolview` | keyed（按工具名） | 工具调用结果的自定义渲染 | 仅见注册点（54 处） |
| `workspace.toast` / `toast.content` | list | 右上角 toast | 仅见注册点（11 处） |
| `deliverables.file.actions` | list | 交付物文件动作 | 仅见注册点 |
| `dsh.sessions.current` / `dsh.trajectory.*` / `dsh.open-in-app.choice` / `dsh.plugin-manager.install-registry` / `dsh.voice-input.microphone` | ? | 各功能包的私有扩展点 | 仅见注册点 |

> 「未找到」：`@deepseek-ai/dsh-client-ui-slots` 的 README 里没有 slot 全量清单，包内也没有 `slot` 定义的 JSON/示例文件；上表靠扫描各包 `lib/client.js` 的 `slots.register({name:...})` 与 `children:{...}` 得到。也没有 `page` / `layout` 这类插槽名——全屏面板就是 `main`。

### 1.4 候选插槽对比（做「独立大面板」该选谁）

| 候选 | 视觉位置 | 能否全屏/大面板 | 结论 |
| --- | --- | --- | --- |
| **`main`** | 主内容区（替代会话界面） | ✅ 整个内容区都给你 | **推荐**。配 `sidebar.panellist` 才能点进去 |
| `shell.overlay` | 覆盖整个框架的浮层 | ✅ 但你得自己画遮罩/关闭 | 适合悬浮窗，不适合常驻页面 |
| `settings.section` | 设置模态内的一页 | ❌ 宽度受限于设置模态 | 适合小卡片（美团就这么用） |
| `sidebar.right.pane.tab` | 右侧停靠面 | ❌ **没有会话就没有停靠面**（README:142） | 不适合全局面板 |
| `sidebar.panellist` | 只是左侧栏的一个图标 | ❌ 只收到 `{size, active}` | 只能当**入口**，不能当面板本体 |
| `sidebar.footer.action` | 侧栏底部按钮 | ❌ | 只能当入口 |

---

## 2. 加载与生效机制

### 2.1 `package.json` 里的 `dsh.client`

解析代码：`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`

```js
// :60-74
function parseDshClient(pkgName, value) {
  // platform 必须是 string（:64）
  // inject / external 必须是 string[]（:65-66）
  //   optionalStringArray 失败抛 `client-modules: ${subject} ${field} must be a string array`
  // immediately 必须是 boolean（:67）
}
```

三个字段的确切语义：

| 字段 | 语义 | 影响点（证据） |
| --- | --- | --- |
| `platform` | 唯一合法值是 `'web'`。**其它值 = 这个包不进客户端模块图**（但 host 侧照常加载）。 | `:732-745` 扫描 Loader 条目时 `if (decl.platform !== 'web') continue` |
| `immediately` | **启动时预取**该 bundle（`prefetch(id)`），不改变激活顺序、不改变时序依赖。首屏就要出现的东西建议 `true`。 | `...\dsh-web-frontend\dist\assets\index-CN7NIWNw.js` 里 `async prefetchImmediateTier(){await Promise.all(this.manifest.plugins.filter(e=>e.immediately).map(e=>this.modules.prefetch(e.id).catch(()=>{})))}`，在 `modules.create({boot, staticModules})` 之后、逐条激活之前 `await` |
| `inject` | `string[]`，**平台包名**（如 `'@deepseek-ai/dsh-client-ui-slots'`）。生成图行 `row.inject`，浏览器侧 `arriveGraphRow` 会**先递归加载这些依赖行**再加载自己。 | host `:400-409` 生成 `{id,url,rev,inject,immediately,external}`；浏览器 `...\dsh-client-modules\lib\client.js:774-791` |
| `external` | `string[]`，同理会先递归加载（第三方外链包）。 | `:400-409`、`client.js:774-791` |

还会校验：声明了 `dsh.client` 但 `exports["./client"]` 不存在 → 抛
`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`（`:732-745`）。

### 2.2 client bundle 的格式（硬约束）

- 加载方式是 **classic script**，不是 ESM：
  `...\dsh-client-modules\lib\client.js:577-591` `defaultLoadBundle` → `document.createElement("script")` + `el.async = true` + `el.src = url`（**没有 `type="module"`**）。
  ⇒ bundle 顶层**不能写 `import` / `export`**，必须是：

  ```js
  window.__ModuleLoader__.load({
    id: '@local/dsh-fish-friends',
    factory(require) { /* ... */ return { name, inject, apply } },
  })
  ```

- `id` 与 `__ModuleLoader__` 的约定：
  - `register(registration)`（`client.js:698-711`）把 id 去掉 `client.` 后缀；重复注册抛
    `client-modules: duplicate factory registration for "..." (bundle executed twice without invalidate?)`
  - 脚本执行完没注册，抛
    `client-modules: bundle script ... loaded without registering "<id>" via __ModuleLoader__.load`
- `factory(require)` 里 `require` 能拿到的**只有平台 seed**（`...\dsh-web-frontend\dist\assets\index-CN7NIWNw.js` 的 `SZ()`）：

  ```
  react, react/jsx-runtime, react-dom, react-dom/client,
  @deepseek-ai/cordis, zod, @tanstack/react-virtual,
  @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
  @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
  ```

  拿别的会抛 `client-modules: require("...") missed the module table — not a platform seed word ...`（`client.js:800-827`）。
- `factory` 的返回值被当成 **cordis 插件对象**激活：`{ name?, inject?: string[], apply(ctx) }`；`inject` 里写的是**服务名**（`slots` / `layout` / `locale` / `remote` / `configForms` …），不是包名。包级 `dsh.client.inject` 写的是**包名**——两者别混。
- 子 chunk（可选）：`require.async("./client.xxx.js")`，文件名必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`。

### 2.3 启动时序（谁先谁后）

`...\dsh-client-modules\lib\index.js:443-472` `bootInjections(graph)` 往 index.html `<head>` 注入：

1. 内联 `__ModuleLoader__` facade（`mode:"queue"`）：
   `window.__ModuleLoader__ = { mode:"queue", pendingQueue, load(registration){ pendingQueue.push(registration) }, create(options){...} }`
   ⇒ bundle 提前执行也安全，注册会先进队列。
2. application combo preload、阻塞 parser 的 bootstrap `<script>`、最后 `window.__DSH_BOOT__` 图（`:572`）。
3. 前端 `TZ.run()`（`index-CN7NIWNw.js`）：
   `modules.create({boot: __DSH_BOOT__, staticModules: SZ(), ...})` → `await prefetchImmediateTier()` → `await kZ({ctx, modules, manifest, onEntryState})` → `$Z`。
4. `kZ` 里：`await ctx.plugin(Kb)`；`ctx.loader.internal = modules`；`await modules.entries.start(ctx.loader, manifest)`；`await ctx.loader.await()`（cordis 依赖满足 → fiber active）；最后 `bZ(ctx, modules)` 做体检：
   - fiber 未定义 → 报 `"<id>: import failed: <msg>"`
   - 非 active → 报 `"<id>: pending (waiting for service...)"`
   - 有失败 → 抛 `web boot: N entries did not activate`

### 2.4 缓存与 revision（为什么改了文件能看到新的）

`...\dsh-client-modules\lib\index.js`：

- `:160` `const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"`
- `serveBundle`（`:990-995`）从**内存** `this.responses / previousBatchResponses / chunkResponse` 取内容，响应头写死 `content-type: text/javascript; charset=utf-8` + `cache-control: public, max-age=31536000, immutable`；只接受 GET/HEAD（否则 405）。
- 破缓存靠 URL 里的 `?rev=`：`client.js:592-596` `atRevision` 要求 URL 含 `rev=`，否则抛 `client-modules: bundle URL ... has no revision`。rev 由 `mtimeMs / ctimeMs / size` 派生（README 提到 `:79`）。
- 结论：**浏览器把 bundle 缓存一年，但改文件 → rev 变 → URL 变 → 必然重新下载**。真正会「改了没反应」的是下面这条：
- **host 侧 `pkgMeta` 缓存从不失效**：`resolveMeta`（`:718-748`）按 `sourceKey` 缓存 `JSON.parse(readFileSync(pkgPath))` 的结果，全局没有 clear/delete；`reconcilePackage`（`:888-908`）在 sourceKey 未变时直接 `return false`。
  ⇒ 给已扫描过的包**新增/修改 `dsh.client`、改 `exports`、改包名** → 必须重启 DSH 才生效。

### 2.5 HMR：安装版有没有？

有。`...\dsh-client-hmr\lib\index.js`：

- `const name = "client-hmr"`，`inject = ["clientModules", "webServer"]`，`Config = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) })`
- 每 `pollIntervalMs` **stat 轮询**每个 graph row 的 client bundle（注释说明：网络挂载不产生 inotify 事件，所以刻意用轮询），比较 `{mtimeMs, ctimeMs, size}` 三元组。
- 变化时 → `ctx.clientModules.rebuilt(id)` → 重建 graph row / 重算 `composed` → 通过 **SSE `/plugins/events`**（`EVENTS_ENDPOINT = "/plugins/events"`，帧 `data: ${JSON.stringify(frame)}\n\n`，带 `graph` / `rebuilt` 两种）通知浏览器。
- 浏览器侧 `invalidate(id, rev)`（`dsh-client-modules\lib\client.js:956-971`）清 factories/loadCache，再以新 `?rev=` 重新 `<script>`，**重新执行 bundle 并用全新状态挂载插件**（插件内的 React 状态会丢，会话/工作区/连接状态保留）。
- README 的 `pnpm run dev:web` 只是「同时起 host + 重建 watcher」的便利命令（`--no-serve` 可只挂 watcher 到别处启动的 host）。**安装版不缺这个能力，改 `client.js` 不需要 dev:web**。

### 2.6 生效方式速查

| 你改了什么 | 怎么生效 |
| --- | --- |
| `client.js` 内容 | 保存后 500ms 内自动重载；否则 F5 刷新页面。**不用重启 DSH** |
| 新增 `client.js`（`exports` 里已声明，之前文件缺失） | 同上（rev 变化即重建）；若之前模块图里没有这一行，重启 DSH |
| `package.json`：`dsh.client` / `exports` / `name` / `files` | **重启 DSH**（`pkgMeta` 缓存不失效） |
| `host.js` / `lib/*.js`（host 侧） | **重启 DSH** |
| 插件首次被装载（profile `bundles`/`dependencies`） | **重启 DSH**（还要 `pnpm install` 建 link） |

---

## 3. `slots.inject` / `slots.register` / `ctx.effect`

### 3.1 为什么必须 `inject` 包一层

插槽不是全局常量，而是**由父组件在自己注册时用 `children` 表声明**的（例如 `root` 由布局包注册，同时声明 `main`、`shell.overlay` 等）。插件加载顺序不确定：直接 `ctx.slots.register({name:'main'})` 很可能在布局注册之前跑，抛
`slot "main" is not declared (a parent entry's children table must declare it)`。

`inject(key, callback)`（`...\dsh-client-ui-renderer\lib\client.js:1367-1426`）做的事：

1. 用 `ctx.effect` 建一个控制器，`subscribeDeclaration(key, changed)`；
2. 声明**已存在** → 同步执行 `callback`；**还不存在** → 等 declaring `register()` 提交后执行（`:1352-1365` 注释原文）；
3. 回调返回的 disposer 在**声明消失**时执行（父条目卸载 / 重新声明导致 `declarationEpoch` 变化 → 先 dispose 再重跑）；
4. 插件 fiber unload 时整个控制器被 cordis 回收。

所以正确写法是：

```js
ctx.effect(
  () => ctx.slots.inject('main', () => ctx.slots.register({ /* ... */ }, Page)),
  'fish-friends: main panel',
)
```

### 3.2 `register` 的返回值

`ctx.slots.register(options, component)`（`renderer\lib\client.js:1602-1622`）→ `_core.register` → 返回**幂等 disposer**。重复执行 `register` 同 `(kind, id/key, priority)` 会抛错（见 1.1），所以**不要**把它放进每次 render 都跑的 effect 里；放进 `ctx.effect` / `slots.inject` 里，让生命周期跟插件一致。

### 3.3 `ctx.effect` 的清理语义

cordis 的 `effect(execute, label = "anonymous")`（`...\node_modules\@deepseek-ai\cordis\lib\index.js:1169-1200`）：

- **立即执行** `execute`；
- 收集它返回的 disposer：支持 `function`、generator、async generator（`runner.collect`）；
- fiber 卸载时**逆序**执行所有 disposer；
- fiber 已死时调用抛 `CORDIS: INACTIVE_EFFECT`。

⇒ 三层生命周期叠加：`ctx.effect`（插件级）→ `slots.inject`（声明级）→ `register` 返回的 entry disposer（条目级）。**entry disposer 会递归移除它 `children` 里声明的子 slot**（`releaseEntry`），所以子 slot 不用单独清。

### 3.4 自己要额外清的东西

- 注入的 `<style>`：`register` 不会帮你删。建议 `const style = document.createElement('style'); style.dataset.plugin = 'dsh-fish-friends'; ...` 并在 disposer 里 `style.remove()`（宿主自己的清理逻辑见 `client.js:309-312` `removeOwnedStyles(id)`，那是 bundle invalidate 时的 `style[data-plugin="<id>"]` 清理，只对 bundle 自身生效，别依赖它）。
- 定时器 / `setInterval` / SSE：包在 `ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) }, 'label')`。
- `window` 事件监听同样返回 disposer。

---

## 4. host 侧 HTTP 通路

### 4.1 `webServer` API（`@deepseek-ai/dsh-host-webserver`）

`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js`

| API | 行号 | 语义 |
| --- | --- | --- |
| `register(route)` | `:325-332` | `route = { kind: 'exact' \| 'prefix', path, handler }`；exact 进 `this.exact`，其余进 `this.prefixes`；重复路径抛 `webserver: duplicate ${route.kind} route "${route.path}"`；返回 `() => table.delete(route.path)` |
| `registerUpgrade(route)` | `:339-345` | WebSocket 升级路由（重复抛） |
| `registerFallback(handler)` | `:354-360` | 兜底路由，第二次注册抛 `webserver: fallback already registered` |
| `match(pathname)` | `:493-503` | exact 优先；前缀匹配 `pathname === prefix \|\| pathname.startsWith(prefix + '/')`；**最长前缀胜** |
| `getOrigin()` | `:313-318` | `http://127.0.0.1:<port>` |

- handler 签名：`async (req, res, next)`（Node 原生 `IncomingMessage` / `ServerResponse`）。
- 错误语义（README.zh.md:61/65/71）：handler 抛错 → 响应 400；响应头已发出则 destroy socket；记 warning，**进程不退出**。
- **没有鉴权层**：只服务本机浏览器/Electron（经 IPC 桥接）。

### 4.2 可直接复制的骨架

`%USERPROFILE%\Desktop\插件开发\dsh-fish-friends\lib\http.js`（新建）：

```js
// 好友面板的 HTTP 接口：/dsh-fish-friends/api/*
import { readDb } from './store.js'
import { affinity, brief, channelText, sessionText } from './score.js'

const PREFIX = '/dsh-fish-friends/api'
const MAX_BODY = 64 * 1024

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 把一条档案压成面板要的字段（别把整个 db 丢给前端：有 log/隐私字段）。 */
function shape(f) {
  return {
    id: f.id,
    name: f.name,
    aliases: f.aliases || [],
    platforms: (f.channels || []).map((c) => `${c.platform} ${c.kind}`.trim()),
    channels: channelText(f),
    session: sessionText(f),
    interests: f.interests || [],
    notes: (f.notes || []).slice(-1)[0] || '',
    affinity: affinity(f),
    brief: brief(f),
    lastTalkAt: f.lastTalkAt || null,
    logCount: (f.log || []).length,
  }
}

const routes = {
  '/health': () => ({ ok: true }),
  '/friends': () => {
    const { db, status, warnings, file } = readDb()
    const friends = (db.friends || [])
      .map(shape)
      .sort((a, b) => b.affinity - a.affinity)
    return { ok: true, friends, settings: db.settings || {}, status, warnings, file }
  },
  // 朋友圈：把「近期的 share / talk」按时间倒序拍平，一条一个卡片
  '/moments': () => {
    const { db } = readDb()
    const items = []
    for (const f of db.friends || []) {
      for (const l of f.log || []) {
        items.push({
          friendId: f.id,
          friendName: f.name,
          kind: l.kind || 'talk',
          text: l.text || l.note || '',
          sent: l.sent === true,
          at: l.at || null,
        })
      }
    }
    items.sort((a, b) => (b.at || 0) - (a.at || 0))
    return { ok: true, moments: items.slice(0, 200) }
  },
}

const handler = async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) {
    if (typeof next === 'function') return next()
    return json(res, 404, { ok: false, error: 'not found' })
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'method not allowed' })
  }
  const route = url.pathname.slice(PREFIX.length) || '/'
  const fn = routes[route]
  if (!fn) return json(res, 404, { ok: false, error: `未知接口 ${route}` })
  try {
    if (req.method === 'POST') await readBody(req)
    return json(res, 200, fn(url.searchParams))
  } catch (e) {
    return json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

export function createHttpHandler() {
  return { path: PREFIX, handler }
}
```

`host.js` 增量（当前只有 7 行、`inject = ['tools']`）：

```js
import { registerTools } from './lib/tools.js'
import { createHttpHandler } from './lib/http.js'

export const inject = ['tools', 'webServer']   // ← 加 webServer

export function apply(ctx) {
  registerTools(ctx)

  const http = createHttpHandler()
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: http.path, handler: http.handler }),
    'fish-friends: http',
  )
}
```

要点：

- `ctx.effect(() => ctx.webServer.register(...))` **必须**包 —— `register` 返回的 `table.delete` 就是 disposer，插件卸载/禁用才不残留路由（重复注册会抛 `duplicate prefix route`）。
- `path` 用 `kind: 'prefix'`：最长前缀胜，`/dsh-fish-friends/apiXX` 不会误伤（匹配要求 `=== PREFIX` 或 `PREFIX + "/"` 开头）；但你还是要在 handler 里复判一次前缀，避免 `next()` 语义出错。
- 返回 `{ path, handler }` 这种「自描述对象」是 meituan 的惯例（`dsh-meituan\lib\http.js:142` `return { path: PREFIX, handler }`），host 侧一行注册，方便测试。
- 统一信封 `{ok:true, ...}` / `{ok:false, error}`，前端 `if (!data?.ok) throw`（见 §5.2 的 `api()`）。
- `cache-control: no-store` 必须自己写；webserver 不会替你设。

### 4.3 安全边界（务必读）

- 外部访问被拒：`...\@deepseek-ai\dsh-client-connection\lib\index.js:800`
  `response.writeHead(this.disposed ? 401 : 403); response.end(this.disposed ? "unauthorized" : "forbidden")`。
  实测 `Invoke-WebRequest http://127.0.0.1:43120/` → **403 forbidden**（没有 launch token）→ 你必须从**已准入的页面**里 fetch（也就是插件面板），外部 curl/脚本拿不到。
- 但「已准入页面」不区分是哪个页面：**任何本机网页**都能对 `127.0.0.1:<port>` 发简单请求（无 CORS 预检的 GET/POST）。所以：
  - 不要在这些路由上做「无需确认就能删数据/发消息」的事；
  - 写操作建议校验 `Origin` / `Host` 头只允许自身 origin，或加一次性 token（`ctx.webServer.getOrigin()` 可拿到自身 origin）；
  - 不要在响应里塞 `friends.json` 的原始 log（可能含隐私），用 §4.2 的 `shape()` 只挑面板要的字段。

---

## 5. 最小可用骨架

### 5.1 `package.json`（现状已够，只需确认三项）

```jsonc
{
  "name": "@local/dsh-fish-friends",
  "type": "module",
  "main": "./host.js",
  "exports": {
    ".": "./host.js",
    "./client": "./client.js",          // ← dsh.client 的必要条件，缺了会抛错
    "./package.json": "./package.json"
  },
  "files": ["host.js", "lib/**", "client.js", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",                          // 必须是 'web'
      "immediately": true,                        // 启动时预取（首屏就要显示）
      "inject": ["@deepseek-ai/dsh-client-ui-slots"]   // 包名，不是服务名
    }
  }
}
```

> 当前文件里 `dsh.client` / `exports["./client"]` / `files` 已按上面写好，**`client.js` 还没创建**。`files` 只是打包白名单；用 `link:` 装载时不影响加载，但别删。

### 5.2 `client.js`（完整可跑：`main` 面板 + `sidebar.panellist` 入口）

```js
// 好友列表 / 朋友圈 面板。
// 约束：classic script（不能有 import/export），React 由宿主提供，组件用 h()。
window.__ModuleLoader__.load({
  id: '@local/dsh-fish-friends',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PANEL_ID = 'dsh-fish-friends'
    const API = '/dsh-fish-friends/api'

    // ---- 取数 ----------------------------------------------------------
    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        method: options?.method || 'GET',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: options?.body ? JSON.stringify(options.body) : undefined,
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)          // 路由被 next() 掉时拿到的是 HTML，别直接 res.json()
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
      }
      if (!data?.ok) throw new Error(data?.error || `请求失败 ${res.status}`)
      return data
    }

    // ---- 样式（用真实存在的 --dsw-alias-* 变量，见 §6.4）----------------
    const S = {
      root: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        font: '13px/1.6 var(--dsw-font-family, system-ui)',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
      },
      title: { fontSize: 15, fontWeight: 600, flex: 1 },
      tabs: { display: 'flex', gap: 4 },
      tab: (on) => ({
        padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: 'none',
        background: on ? 'var(--dsw-alias-bg-layer-3, #eef0f3)' : 'transparent',
        color: on ? 'var(--dsw-alias-label-primary, #1f2329)' : 'var(--dsw-alias-label-secondary, #6b7280)',
      }),
      body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px' },
      row: (on) => ({
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '10px 12px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
        background: on ? 'var(--dsw-alias-bg-layer-2, #f7f8fa)' : 'transparent',
        border: '1px solid ' + (on ? 'var(--dsw-alias-border-l3, #e5e6eb)' : 'transparent'),
      }),
      name: { fontWeight: 600 },
      meta: { color: 'var(--dsw-alias-label-tertiary, #8f959e)', fontSize: 12 },
      badge: {
        fontSize: 11, padding: '1px 6px', borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-4, #eef0f3)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      empty: { padding: 24, color: 'var(--dsw-alias-label-tertiary, #8f959e)' },
      err: { padding: '8px 16px', color: 'var(--dsw-alias-state-error-primary, #d92d20)' },
    }

    // ---- 列表 ----------------------------------------------------------
    function FriendRow({ f, onOpen }) {
      return h('div', {
        style: S.row(false),
        onClick: () => onOpen(f),
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, #f7f8fa)' },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
            h('div', { style: S.name }, f.name),
            f.platforms?.length ? h('span', { style: S.badge }, f.platforms.join(' / ')) : null,
            h('span', { style: S.badge }, `亲密 ${f.affinity}`),
          ),
          h('div', { style: S.meta }, f.brief),
          f.notes ? h('div', { style: { ...S.meta, marginTop: 2 } }, f.notes) : null,
        ),
      )
    }

    function MomentItem({ m }) {
      return h('div', { style: { padding: '8px 4px', borderBottom: '1px solid var(--dsw-alias-border-l1, #f2f3f5)' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          h('span', { style: S.name }, m.friendName),
          h('span', { style: S.badge }, m.kind === 'share' ? (m.sent ? '已分享' : '待分享') : '聊天'),
          h('span', { style: S.meta }, m.at ? new Date(m.at).toLocaleString() : '时间未知'),
        ),
        m.text ? h('div', { style: { marginTop: 4 } }, m.text) : null,
      )
    }

    // ---- 页面 ----------------------------------------------------------
    function FriendsPage(props) {
      const [tab, setTab] = useState('friends')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          setData(await api(tab === 'friends' ? '/friends' : '/moments'))
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [tab])

      useEffect(() => { load() }, [load])

      const list = tab === 'friends'
        ? (data?.friends || []).map((f) => h(FriendRow, { key: f.id, f, onOpen: () => props.openFriend?.(f) }))
        : (data?.moments || []).map((m, i) => h(MomentItem, { key: `${m.friendId}-${i}`, m }))

      return h('div', { style: S.root },
        h('div', { style: S.head },
          h('div', { style: S.title }, '鱼友'),
          h('div', { style: S.tabs },
            h('button', { style: S.tab(tab === 'friends'), onClick: () => setTab('friends') }, '好友'),
            h('button', { style: S.tab(tab === 'moments'), onClick: () => setTab('moments') }, '朋友圈'),
          ),
          h('button', { style: S.tab(false), onClick: load, disabled: loading }, loading ? '读取中…' : '刷新'),
        ),
        error ? h('div', { style: S.err }, error) : null,
        h('div', { style: S.body },
          list.length ? list : h('div', { style: S.empty },
            tab === 'friends' ? '还没有鱼友。让模型调用 friends_upsert 加一个。' : '还没有互动记录。'),
        ),
      )
    }

    // ---- 侧栏图标（只收到 { size, active }）-----------------------------
    function FriendsPanelIcon({ size = 18, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        style: { opacity: active ? 1 : 0.75 },
      },
        h('circle', { cx: 9, cy: 8, r: 3.2 }),
        h('path', { d: 'M3.5 19c.6-3 2.9-4.6 5.5-4.6s4.9 1.6 5.5 4.6' }),
        h('circle', { cx: 17.5, cy: 9.5, r: 2.4 }),
        h('path', { d: 'M15.2 18.6c.4-2.1 1.9-3.3 3.8-3.3' }),
      )
    }

    return {
      name: 'fish-friends-ui',
      inject: ['slots', 'layout'],   // 服务名，不是包名
      apply(ctx) {
        // 全局面板：main 是 keyed slot，key 就是面板 id
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: 'fish-friends',
            // inject 的返回值直接成为组件 props；顺带给页面一个「回会话」的出口
            inject: () => ({ openFriend: () => ctx.layout.selectPanel(null) }),
          }, FriendsPage)),
          'fish-friends: main panel',
        )

        // 左侧栏入口：id 必须等于 main 的 key，点击才会 selectPanel(id)
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => '鱼友',
            locale: 'fish-friends',
          }, FriendsPanelIcon)),
          'fish-friends: sidebar entry',
        )
      },
    }
  },
})
```

配套：`ctx.layout.selectPanel(PANEL_ID)` 任意地方都能切进来（`layout` 服务由 `dsh-client-ui-layout` 提供，`...\dsh-client-ui-layout\lib\client.js:622` `ctx.reflect.provide("layout", layout)`）；`selectPanel(null)` 回会话界面。

### 5.3 其它插槽的注册示例（对照用，来源均为真实包）

`settings.section`（设置里的一页，美团用的就是这个）：

```js
// %USERPROFILE%\Desktop\插件开发\dsh-meituan\client.js:388-393（原文）
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-meituan',
  order: 71,
  label: () => '美团外卖',
}, MeituanPage))
```

`sidebar.panellist` + `main`（插件管理器的完整范式，含 store）：

```js
// ...\@deepseek-ai\dsh-client-ui-plugin-manager\lib\client.js:4451-4528（节选）
ctx.slots.inject('main', function* () {
  const handle = createNavigationStore()
  const instance = handle.create()
  const store = { ...handle, create: () => instance }
  yield ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,
    inject: () => face,
    children: {
      'plugins.header.leading': { kind: 'single', scope: 'root' },
      'plugins.overview': { kind: 'list' },
      'plugins.tab': { kind: 'list' },
    },
  }, PluginsPage)
})

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 0,
  label: () => t('panel'),
  locale: NS,
}, PluginsPanelIcon))
```

`shell.overlay`（浮层，悬浮灯/通知这种）：

```js
// ...\@deepseek-ai\dsh-client-ui-chat\lib\client.js:13288（节选）
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'chat.quota-notice',
  locale: NS,
  children: { 'shell.quota-notice': { kind: 'chain', scope: 'root' } },
  inject: () => ({ hooks: { /* ... */ }, dismissNotice }),
}, Comp))
```

`sidebar.right.pane.tab`（两段式，必须**先**注册 tab 定义**再**注册 slot）：

```js
// ...\dsh-client-ui-sidebar-right\README.zh.md:83-84 的用法
const tab = ctx.sidebarRightTabs.register({
  id: 'fish-friends.friends',
  kind: 'friends',
  title: '鱼友',
  canOpen: () => true,
})
ctx.effect(() => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: tab.id },
  FriendsPaneBody,   // 正文里用 useTabInfo() 拿 { sidebar, panel, tab }
), 'fish-friends: right tab')
```

---

## 6. 坑

### 6.1 缓存 / 生效

- bundle 是 `cache-control: public, max-age=31536000, immutable`。**看起来没更新**时先看 DevTools Network 里 URL 的 `?rev=` 有没有变；没变说明 host 侧 `clientModules.rebuilt()` 没触发（文件 stat 没变？改的是别处？），不是浏览器缓存。
- `pkgMeta` 只读一次 `package.json`：改 `dsh.client` / `exports` **一定重启**，别浪费时间刷页面。
- 插件没被 profile 装载时，UI 完全不出现、控制台也没有报错（它根本不在模块图里）。先查 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles`。
- HMR 重载会**重新执行整个 bundle 并全新挂载**：放在模块顶层的可变状态（缓存、`let count`）会归零；要跨重载保留就放 `sessionStorage` / `localStorage`。
- 重复 `register` 会抛错而不是覆盖：`single slot ... already has a registration`、`list slot ... already has an entry with id ...`。改注册代码后如果 HMR 没清干净，刷新页面。
- 报错串速查（都在这里查到过原文）：
  - `slot "main" is not declared (a parent entry's children table must declare it)` → 没包 `slots.inject`，或插槽名写错。
  - `client-modules: bundle script ... loaded without registering "<id>"` → `window.__ModuleLoader__.load` 的 `id` 与图里的 id 不一致（必须等于包名）。
  - `client-modules: duplicate factory registration for "..."` → 同一 bundle 被执行两次且没 invalidate。
  - `client-modules: require("...") missed the module table — not a platform seed word` → require 了不在 seed 表里的东西（见 §2.2 的 11 个）。
  - `web boot: N entries did not activate` → factory 返回的插件 `inject` 里有服务没就绪（看控制台里 `pending (waiting for service...)` 那行）。

### 6.2 bundle 形态

- **不能有 ESM 语法**（`import` / `export` / `export default`）。看着像 ESM 是因为 meituan 的 `host.js` 是 ESM；`client.js` 不是。
- 不能用 JSX（没有编译步骤）；用 `React.createElement`，或宿主 `react/jsx-runtime` 也可以（`require('react/jsx-runtime').jsx`），但手写 `h()` 最省事。
- 别自己 `createRoot` 挂到 `document.body`：渲染根由宿主管，你只返回组件。
- `require('react-dom')` 虽然能拿到，但不要用来做 portal 到 body 之外——面板容器会随 `selectPanel` 卸载。

### 6.3 React 版本

- 宿主是 **React 18.3.1**（`C:\Program Files\DSH Desktop\resources\app\node_modules\react\package.json`）。`useSyncExternalStore` / `useId` 可用，React 19 的 `use()`、Server Components 不可用。
- 不要自带一份 React：用的是宿主 seed 里的单例，自带会导致 hooks 报 `Invalid hook call`。

### 6.4 CSS 变量（**不要照抄美团**）

真实存在于 `...\dsh-web-frontend\dist\assets\index-BxpfOGf3.css` 的变量（节选，全部 55 个里常用的）：

```
背景   --dsw-alias-bg-base  --dsw-alias-bg-layer-1  --dsw-alias-bg-layer-2
       --dsw-alias-bg-layer-3  --dsw-alias-bg-layer-4  --dsw-alias-bg-mask-1
文字   --dsw-alias-label-primary  --dsw-alias-label-secondary  --dsw-alias-label-tertiary
       --dsw-alias-label-caption  --dsw-alias-label-dimmed  --dsw-alias-label-error
       --dsw-alias-label-link
边框   --dsw-alias-border-l1  --dsw-alias-border-l2  --dsw-alias-border-l3  --dsw-alias-border-l4
品牌   --dsw-alias-brand-primary
状态   --dsw-alias-state-error-primary  --dsw-alias-state-success-primary
       --dsw-alias-state-warn-primary  --dsw-alias-state-idle-primary
交互   --dsw-alias-interactive-bg-hover  --dsw-alias-interactive-bg-active
       --dsw-alias-button-primary-fill  --dsw-alias-tooltip-bg  --dsw-alias-toast-bg
形状   --dsw-radius-xs/sm/md/lg/panel  --dsw-elevation-soft/panel/prominent  --dsw-shadow-lv3
字体   --dsw-font-family   --dsw-focus-ring-color  --dsw-focus-ring-width
```

⚠️ `dsh-meituan\client.js:11-22` 用的 `--dsw-alias-bg-primary`、`--dsw-alias-bg-secondary`、`--dsw-alias-border-primary`、`--dsw-alias-state-warning-primary` 在这套主题里**一个都不存在**（index CSS / vendor CSS / 前端 JS 全 0 命中），它只是靠 `var(..., #hex)` 的 fallback 在撑——所以它在深色模式下颜色是错的。写新面板时用上表的名字，并保留 fallback。

### 6.5 布局 / 尺寸

- `main` 的容器是 `renderSlot("main")` 那片区域，高度是受父容器约束的 flex 区。页面根节点要写 `height: '100%'` + `display: 'flex'`，滚动条交给内部 `overflow: 'auto'` 的那层；否则长列表会把框架顶开。
- 不要 `position: fixed` 铺满：`selectPanel(null)` 回会话时残留遮罩很难看。要浮层就注册 `shell.overlay`。

### 6.6 CSP / 安全

- 主窗口 `...\dsh-web-frontend\dist\index.html`（825 B）**没有 CSP meta**，只有 `<script type="module" src="./assets/index-*.js">`。⇒ 你可以注入 `<style>`、`<script>`。CSP 只出现在**沙箱 iframe 预览**（`sandbox; default-src 'none'`）和登录平台（nonce）里——如果面板未来要嵌第三方资源（图片/iframe），在沙箱预览里会被拦，别指望它。
- host 路由从页面 fetch 是可行的（页面已带 launch token），外部 curl 403。但也意味着「任何本机网页」都能打你的路由：写操作加 Origin 校验或 token（§4.3）。
- 不要把 `friends.json` 全量返回（含 `log`、可能含隐私）：用 §4.2 的 `shape()`。

### 6.7 其它「未找到 / 未验证」

- `@deepseek-ai/dsh-client-ui-slots` 未随包安装 `lib/types/*.d.ts`，**没有 TypeScript 类型可查**；options 结构以上文 `:204-219` 的运行时白名单为准。
- slot 全量清单没有官方文档（见 §1.3 说明），上表是 grep 结果；`?` 的 kind 不是契约。
- 组件抛错时的边界行为（是否被 renderer 的 error boundary 兜住）**未验证** —— 别让面板在 render 阶段抛错，用 state 渲染错误条。
- `@deepseek-ai/dsh-client-ui-primitives` 里有 `Button / Input / Pill / Tag / Tooltip / Modal / Menu / StateDot / Switch / Checkbox / SegmentedControl / SegmentedTabs / HoverCard / DisclosureRow / ConnectionIndicator / JsonTree / MarkdownText / ReferenceChip` 等，以及 `IconUsersOutlineRegular / IconRefreshOutlineRegular / IconCloseOutlineRegular / IconSearchOutlineRegular / IconPlusOutlineRegular` 等图标；但它们的具体 props 没读，**用前先 grep 那个包**，或直接像 §5.2 那样手写内联样式（零依赖，最稳）。
