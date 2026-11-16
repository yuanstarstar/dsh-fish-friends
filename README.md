# dsh-fish-friends · 鱼友簿（v0.5.1）

给 DSH 用的本地插件：记鱼友是谁、在哪、爱看什么、多久没说话；按内容挑最合适的人；**用桥接收发消息**，同一个人来第三次就自动建档、在专属工作区开专属会话接住他；专属会话可限流，机器人闲了还能按亲密度主动找人聊。

纯本地，数据落在 `$DSH_HOME/fish-friends/friends.json`；桥接目录在 `$DSH_HOME/fish-friends/bridges/`，专属工作区在 `$DSH_HOME/fish-friends/workspaces/`。不联网、不收集任何东西。

## 装法（Windows，desktop profile）

推荐用 GUI：左侧栏 **插件** 页 → 安装本地包 → 选这个目录（`link:` 方式）。
命令行等价：

```powershell
# 1) 链接进 profile（在 profile 目录里跑 pnpm）
& "<runtime>\node\bin\node.exe" "<runtime>\pnpm\bin\pnpm.mjs" --dir "$env:USERPROFILE\.dsh\profiles\desktop" add "link:<解压后的 dsh-fish-friends 目录，用正斜杠>"

# 2) 把 @local/dsh-fish-friends 加进 package.json 的 dsh.profile.bundles
# 3) 完全退出并重启 DSH
```

改了 `client.js`：刷新页面即可（安装版自带 HMR，500ms 轮询 + SSE）。
改了 `host.js` / `lib/*` / `package.json`：必须重启 DSH。

## 面板（v0.5）

左侧栏「鱼友簿」图标 → 打开 `main` 全局面板（不是设置里的一页），右上「回会话」回对话。

| 区块 | 内容 |
| --- | --- |
| 朋友圈 | 每人一张卡：亲密度条、**常出没时段**、爱好、通道、会话状态、最近 3 条互动；按亲密度排序 |
| 这条内容，发给谁？ | 输入标题 + 关键词 → `/for` → 只回命中的人（默认 1 个 + 3 个备选），可直接投到会话 |
| 找个人 | 名字/别名/爱好/印象/最近聊过 |
| 交友目标 | 每天想认识几位（区间）、提醒间隔、每日提醒上限；「现在就提醒一次」 |
| 桥接 | 新建（file / http / mock）、启停、收发计数、收件目录 |
| 消息怎么分 | **多个总台**（加/移除，轮流接；每个可单独勾「交友提醒」）、建档阈值、专属会话限流窗口与条数、**公共场合聊熟自动转私聊**（开关 / 聊够几条 / 冷却小时 / 开场提示）；「待建档」的人可直接点「现在就建档」 |
| 消息流 | 最近 60 条进出站消息 + 各自去了总台/专属/转私聊/限流暂存；可「此刻补投限流暂存」 |
| 主动闲聊 | 总闸、时段、间隔、每日上限、模式（模板 / 让专属会话自己想一句）、「现在试一次」、下次大概何时找谁 |

## 桥接：消息怎么进来、怎么出去

「桥接让机器人自己做好」= 插件提供三种适配器，外部平台只需要读写文件或转发一个 URL。

| 类型 | 入站 | 出站 |
| --- | --- | --- |
| `file` | 往 `bridges/<id>/in.jsonl` **追加一行 JSON**：`{"uid":"123","name":"阿蓝","text":"在吗"}` | 插件把回信追加到 `bridges/<id>/out.jsonl`，你的脚本读走再发出去 |
| `http` | 用 `friends_inbox` 或 `POST /inbound` 投进来 | 插件 POST 到 `config.sendUrl`，body `{bridgeId,to,name,text,kind}`；`config.token` 走 Bearer |
| `mock` | 同上 | 只记出站（自测用） |

file 桥的轮询器每 1 秒扫一次启用的桥；**首次启动跳到文件末尾**，不会重放历史消息；坏行跳过不炸。

外部平台最小接法（伪代码）：

```python
# 收到私信 → 写进去
with open(r"%USERPROFILE%\.dsh\fish-friends\bridges\<id>\in.jsonl", "a", encoding="utf-8") as f:
    f.write(json.dumps({"uid": uid, "name": name, "text": text}, ensure_ascii=False) + "\n")

# 要发的话 → 从 out.jsonl 读出来（记好读到的字节位置）
```

## 消息怎么分（路由规则）

1. 看发送者在不在鱼友簿里：**不在** → 记进 `pendingSenders`（按 `桥:uid` 计数），不够阈值就不投任何会话。
2. 计数达到 `routing.promoteAfter`（默认 **3**）→ 自动建档：建 friend（`autoCreated:true`）、在 `workspaces/<名字>-<id>/` 建工作区、用 `sessionController.create({cwd})` 建**专属会话**并绑定。
   并发安全：同一个人连发/并发进来时先原子「查重 + 占位建档」，建档进行中到达的消息先进 `holds`（`reason:"promoting"`），**不会建出两份档案**。
3. 已建档的人 → 只进**他的专属会话**，总台会话不再接他的消息。
4. 没有专属会话的人（比如手动记的老朋友）→ 进你设的**总台会话**；**总台可以有多个**（`routing.sharedSessions[]`），按「最久没接」轮流投，谁空闲给谁。总台也没设 → 只记录不投。
5. 专属会话限流：`rate.windowMs` 内最多 `rate.max` 条；超出的消息进 `holds`（**不丢**），每分钟自动重试补投，也可在面板点「补投」。
6. 一个人可以有**多个联系方式**（`friend.channels[]`，不同平台的 uid），但都挂**同一个专属会话**；同一个人的档案重复了用 `friends_merge` 并档（通道/爱好/别名/聊天记录都合并）。

投递文案：总台 `【桥名/发送者】原话`，专属 `【桥名】原话`，方便会话里的机器人知道是谁。

### 公共场合聊熟 → 自动转私聊（v0.5）

在**总台**里和一个已认识的人聊够 `publicToPrivate.afterMessages` 条（默认 2），且距上次邀请超过 `cooldownMs`（默认 24h）→

1. 给他建/复用**专属会话**（工作区在 `workspaces/<名字>-<id>/`）；
2. 往专属会话投一条「私聊邀请」指令，让里面的机器人用 `friends_send` 开口；
3. 记一条 `route:"invited"` 的消息，并在面板请求切到那个会话（类似「有人找你」的跳转）。

开关与参数：`friends_route {action:"set", publicToPrivate:true, publicAfterMessages:2, publicCooldownHours:24, opener:"..."}`，或面板「消息怎么分」里勾。手动催：「那一句话」用 `friends_private {name:"阿蓝"}`。

### 朋友作息（v0.5）

`friends_rhythm {name:"阿蓝"}`（或 `all:true`）按最近 30 天的收发记录算：常出没的小时（`activeHours`）、高峰、平均间隔、现在是否通常在线、下次可能在线。面板上每人卡片也会直接显示「常出没 20:00-23:00」。

### 交友目标（v0.5）

`friends_goal {action:"set", enabled:true, min:3, max:8, remindEveryHours:2, dailyCap:3}`：

- 「今天认识几位」= 今天新建档的好友数（`friend.createdAt` 在当天）；
- 没达标、不在休息时段（8:00–23:00 之外不打扰）、没到每日上限、距上次提醒够久 → 给**参与提醒的总台**（默认全部）投一条提醒，让里面的机器人主动去公共频道找人聊、聊到合适的就用 `friends_upsert` 记下来；
- 只想让部分总台接提醒（比如有一个总台专门回私信，不想被打扰）：面板「消息怎么分」里每个总台后面有「交友提醒」勾选框；也可以用 `friends_route {action:"set", sharedRef:"session-…", setGoal:false}` 关掉，`setGoal:true` 打开。关掉的总台照常接陌生人消息，只是不收交友提醒；
- 面板「交友目标」卡片可直接改、「现在就提醒一次」；也可 `friends_goal {action:"now"}`。

### 新会话的交接记忆（v0.4.2）

新开的会话不继承别的会话的记忆，进去的模型不知道对面是谁。所以每次把消息投进**一个还没交接过的专属会话**时，会在同一次投递里先附一段交接记忆：

```
【鱼友簿 · 会话交接｜系统提示，不是 TA 说的话｜只用来对齐记忆：不要回复这条，也不要为这条调用 friends_send】
· 对方是谁：名字、桥名/uid、别名、亲密度、互动次数、爱好、印象
· 你们的来历：自动建档 / 换的新会话 / 手动绑定 / 第一次
· 最近聊过什么：最近 8 条收发 + 建档前攒的几句
· 怎么回：用 friends_send，name 填名字；别自我介绍、别问「你是谁」

—— 下面这条才是 TA 刚发来的消息 ——
【桥名】原话
```

- 和 TA 的第一条消息拼成**一次**投递，避免模型对交接说明单独回一句、甚至误发给 TA。
- 同一会话只交接一次（记在 `friend.briefed = {sessionRef, at}`）；换绑/换绑新会话会重新交接（措辞变成「换的新会话」）。
- 交接投不进去不影响消息本身：会自动退一步只投消息，并在消息备注里写「交接记忆没送到（原因）」。
- 想强制重发：`friends_session {name:"阿蓝", rebrief:true}`。

## 主动闲聊

- 总闸 `settings.proactive.enabled` + 每人自己的 `friend.proactive.enabled`（都开才生效）。
- 时段：`windowFrom`~`windowTo`（小时，可跨夜；from===to 视为全天）。
- 间隔：`minGapMs`~`maxGapMs`，**亲密度越高越靠近 minGap**；再按 `jitter`（默认 ±20%）随机抖动，避免整点齐发。
- 每日上限 `dailyCap`；「闲着」= 距上次联系（最后一条消息或 lastTalkAt）超过目标间隔。
- 模式：`template`（本地模板，不花 token）/ `agent`（往专属会话投一句指令，让会话里的机器人自己组织语言再 `friends_send`）。
- 每分钟检查一次，每次最多 3 人；也可 `friends_proactive {action:"now"}` 立刻试。

## 工具（19 个）

| 工具 | 干什么 |
| --- | --- |
| `friends_upsert` | 记/改一条鱼友（只按精确名更新；相似名不并档）；可带 `session` 绑定 |
| `friends_note` | 记一条互动，顺便更新「上次说话」 |
| `friends_list` | 列鱼友（`sort`: close / name / recent / stale，`limit`） |
| `friends_due` | 谁超过 N 天没说话 |
| `friends_show` | 看一个鱼友的档案 + 会话 + 最近 10 条 |
| `friends_search` | 关键词找人（名字/别名/爱好/印象/最近聊过），默认 5 条 |
| `friends_for` | **内容→发给谁**：默认 1 人，给分数/理由/通道/会话 + 备选，不读整表 |
| `friends_share` | 记一条分享；`sent:true` 才算真发出去（才加亲密度） |
| `friends_session` | 会话：`list:true` 列宿主会话、`create:true` 新建再绑、`ref` 绑定、`clear:true` 清除、`rebrief:true` 强制重发交接记忆、`cwd` 指定工作区 |
| `friends_activate` | 激活某人的会话：投 `text`（会唤醒冷会话）、`jump` 让面板切过去 |
| `friends_bridge` | 桥接：`list` / `add`（file 会建收件目录）/ `remove` / `toggle` / `test` |
| `friends_inbox` | **模拟外部消息进来**：`{bridge, uid, name, text, count}` → 走同一条 ingest（计数、建档、路由、限流） |
| `friends_send` | **通过桥发给某人**：`{name, text, bridge?, kind}` → 写 out 并记一笔 |
| `friends_route` | 路由设置：`get` / `set`（`addShared` 加总台、`removeShared` 移除、`clearShared` 清空、`promoteAfter`、限流、公共场合转私聊、清待建档；`setGoal`+`sharedRef` 控制这个总台接不接交友提醒）/ `release` 补投 |
| `friends_proactive` | 主动闲聊：`get/set/now/enableAll/disableAll` |
| `friends_rhythm` | 朋友作息：`{name}` 单人，`{all:true, days}` 按互动次数排前 20 |
| `friends_goal` | 交友目标：`get/set/now`（`enabled/min/max/remindEveryHours/dailyCap/force`） |
| `friends_private` | 手动转私聊：`{name, text?}` → 让 TA 的专属会话主动开口 |
| `friends_merge` | 并档：`{from, into, dryRun?}` → 通道/爱好/别名/记录合并到保留的那份 |

## 亲密度怎么算

0~100，四段相加后 clamp：

- 互动次数：每次 +8，封顶 55（聊天，不算分享）
- 新鲜度：每天 -2，20 天掉光（40 分）
- 真发出去的分享：每条 +2，封顶 10
- 保底 20 分

## 匹配分怎么算

`亲密度 × 0.3 + 爱好命中（每个 18，最多 3 个）+ 最近 8 条里命中爱好（每个 8，最多 2 个）+ 时间加成（3 天内 +8 / 7 天内 +4 / 从没聊过 -10）`，最后 **clamp 100**。

所以「这个人是塔防党」最多值 54 分，不会被高亲密度无上限地压过去。

## 会话怎么用

```text
friends_session { list:true }                                  # 先看宿主有哪些会话（id + 标题）
friends_session { name:"阿蓝", ref:"session-xxxx", label:"塔防群" }   # 绑定
friends_session { name:"阿蓝", create:true }                   # 新建一个再绑
friends_activate { name:"阿蓝", text:"看到个塔防开局，发你看看" }    # 投消息 + 面板切过去
friends_session { name:"阿蓝", rebrief:true }                    # 换会话后强制重发交接记忆
```

- `ref` 是 DSH 会话 id（`session-<uuid>`）或子代理地址对象，也可以是外部链接（`kind:"url"`）。
- host 侧只能读列表 / 发消息 / 建会话，**不能**切 UI；切 UI 由面板里的常驻浮层做：host 把激活写进 `activations` 队列，浮层轮询 `/pending` 后调 `uiWorkspace.openSession`，再 ack。
- `prompt` 对冷会话会先 resume 再投，所以「切过去」之前机器人的话已经进去了。

## HTTP 接口（面板用）

前缀 `/dsh-fish-friends/api`，同源、无鉴权（只有本机 GUI 能打；外部 curl 会被 webServer 拦成 403）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 探活 |
| GET | `/graph` | 面板整页数据（好友卡片 + 桥接 + 消息流 + 待建档 + 宿主动态 + 主动闲聊预览） |
| GET | `/for?text=&tags=&limit=` | 内容→发给谁 |
| GET | `/search?q=` | 关键词找人 |
| GET | `/pending` | 待切会话队列 |
| POST | `/pending/ack` | `{ids?}` 确认已切 |
| POST | `/for` | 同上，body `{text,tags,limit}` |
| POST | `/session` | `{action:bind\|clear\|list, name, kind, ref, label}` |
| POST | `/activate` | `{name, message?, note?, mode?}` |
| POST | `/share` | `{name?, text, tags?, sent}` |
| POST | `/note` | `{name, text, mood?}` |
| POST | `/bridge` | `{action:add\|toggle\|remove, name?, kind?, id?}` |
| POST | `/routing` | `{sharedRef?, sharedLabel?, addShared?, removeShared?, clearShared?, promoteAfter?, rateWindowMinutes?, rateMax?, publicToPrivate?, publicAfterMessages?, publicCooldownHours?, opener?, promote?, bridgeId?, uid?, name?}` |
| POST | `/private` | `{name, text?}` 手动转私聊 |
| POST | `/goal` | `{action:"get\|set\|now", enabled?, min?, max?, remindEveryHours?, dailyCap?, force?}` |
| POST | `/merge` | `{from, into}` 并档 |
| POST | `/proactive` | `{enabled?, windowFrom?, windowTo?, minGapHours?, maxGapHours?, dailyCap?, mode?, action:"now"}` |
| POST | `/send` | `{name, text, bridge?}` |
| POST | `/inbound` | `{bridge, uid, name, text, at?}` |
| POST | `/release` | 立即补投限流暂存 |
| GET | `/rhythm?name=&days=` | 作息（无 name 返回排行榜） |

## 数据文件（version 5）

```json
{
  "version": 5,
  "friends": [
    {
      "id": "f_...",
      "name": "阿蓝",
      "aliases": ["蓝蓝"],
      "interests": ["塔防", "roguelike"],
      "channels": [
        { "platform": "b_...", "kind": "QQ", "uid": "123" },
        { "platform": "b_...", "kind": "B站私信", "uid": "456" }
      ],
      "session": { "kind": "dsh", "ref": "session-...", "label": "阿蓝" },
      "briefed": { "sessionRef": "session-...", "at": 1700000000000 },
      "autoCreated": true,
      "sourceBridge": "b_...",
      "limits": { "windowMs": 0, "max": 0 },
      "proactive": { "enabled": true, "mode": "template", "lastProactiveAt": 0 },
      "lastPrivateInviteAt": 0,
      "createdAt": 1700000000000,
      "log": [],
      "lastTalkAt": 1700000000000
    }
  ],
  "bridges": [{ "id": "b_...", "name": "QQ", "kind": "file", "enabled": true, "config": {}, "stats": { "in": 3, "out": 2, "errors": 0, "promoted": 1 } }],
  "pendingSenders": [{ "key": "b_...:123", "bridgeId": "b_...", "uid": "123", "count": 2 }],
  "holds": [],
  "outbox": [],
  "messages": [{ "id": "m_...", "at": 1700000000000, "dir": "in", "route": "dedicated", "friendId": "f_...", "name": "阿蓝", "text": "在吗" }],
  "activations": [],
  "settings": {
    "shareLimit": 1,
    "routing": {
      "promoteAfter": 3,
      "sharedSessions": [{ "id": "s_...", "kind": "dsh", "ref": "session-...", "label": "总台甲", "enabled": true, "createdAt": 0, "lastAt": 0 }],
      "workspaceDir": "",
      "publicToPrivate": { "enabled": false, "afterMessages": 2, "cooldownMs": 86400000, "opener": "" }
    },
    "rate": { "windowMs": 3600000, "max": 30 },
    "proactive": { "enabled": false, "windowFrom": 9, "windowTo": 23, "minGapMs": 21600000, "maxGapMs": 259200000, "dailyCap": 2, "mode": "template", "jitter": 0.2 },
    "goal": { "enabled": false, "min": 3, "max": 8, "remindEveryMs": 7200000, "dailyCap": 3, "dayKey": "", "sentToday": 0, "lastRemindAt": 0 }
  }
}
```

- `sharedSessions`：多个总台，按 `lastAt` 最久的先接；0.4 的单个 `sharedSession` 读入时自动迁移成数组第一项。
- **坏 JSON 不会静默清空**：原文件先备份成 `friends.corrupt-<时间>.json`，工具会提示，下一次写入照常。
- 写入是「临时文件 + 备份 + 原子 rename」，并发写入串行化。
- 上限：`log` 80 条/人、`messages` 300、`holds` 200、`outbox` 200、`pendingSenders` 100、`bridges` 20、`activations` 20。

## 已知限制

- 面板是只读展示 + 少量操作（bridge 增删启停、路由/主动闲聊设置、建档、补投）；改好友资料仍走工具。
- host 不能切 UI，切会话靠浮层轮询，最多 5 秒延迟。
- file 桥靠轮询（1 秒），不是实时推送；需要实时就写 http 桥。
- 主动闲聊的 `agent` 模式要专属会话里的机器人真的调用 `friends_send`，否则只会记一条「已提醒」。
- 时段按本机时区的小时数判断，不处理夏令时。

## 目录

```
host.js            宿主入口：注册 19 个工具 + webServer HTTP + 桥接/主动闲聊/交友目标运行时
client.js          浏览器面板：main 面板 + sidebar.panellist 入口 + 激活浮层
lib/store.js       读写、迁移、坏数据兜底、原子写、桥/待建档/消息/限流/多总台归一化
lib/score.js       亲密度、匹配分、搜索分、排行
lib/bridge.js      file/http/mock 桥适配器、file 轮询、outbox 重试
lib/routing.js     路由：计数→建档→专属会话、限流 hold、公共场合转私聊、出站发送
lib/proactive.js   主动闲聊：时段/间隔/每日上限/模板与 agent 模式
lib/rhythm.js      朋友作息：活跃小时、高峰、平均间隔、下次可能在线
lib/goal.js        交友目标：每日新增数、提醒节奏、休息时段
lib/briefing.js    新会话的交接记忆
lib/tools.js       19 个工具
lib/session.js     会话列表/描述/投递/激活队列
lib/http.js        面板 HTTP 路由
cordis.patch.yml   注册到 loader 的补丁
test/              v2（数据层 18）/ v3（会话+工具+HTTP 24）/ v4（桥接+路由+主动闲聊 23）/ v5（多总台+转私聊+作息+目标 10）/ brief / dup / dup-promote / signal / smoke-host
docs/              研究-0.1.0.md、sessions-api.md、ui-api.md、改动记录-0.3.md、改动记录-0.4.md、改动记录-0.5.md
```
