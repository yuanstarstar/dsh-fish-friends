// 数据层 v2：容错读取、原子写入、版本迁移、写串行化。
// 数据文件：$DSH_HOME/fish-friends/friends.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 5

export function homeDir() {
  const h = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(h, 'fish-friends')
}
export const dataFile = () => path.join(homeDir(), 'friends.json')
export const backupFile = () => path.join(homeDir(), 'friends.json.bak')
export const corruptFile = (stamp) => path.join(homeDir(), `friends.corrupt-${stamp}.json`)

export const now = () => Date.now()
export const norm = (s) => String(s ?? '').toLowerCase().trim()

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

// 总台可以有多个（陌生人/公共场合的消息轮流进），老数据里的单个 sharedSession 会自动迁移进来
const DEFAULT_ROUTING = {
  promoteAfter: 3,
  sharedSessions: [],
  workspaceDir: '',
  // 在公共场合（总台会话）聊起来的人：自动给 TA 开私聊会话并让机器人接着聊
  publicToPrivate: { enabled: false, afterMessages: 2, cooldownMs: 86400000, opener: '' },
}
const DEFAULT_RATE = { windowMs: 3600000, max: 30 }
const DEFAULT_PROACTIVE = {
  enabled: false,
  windowFrom: 9,
  windowTo: 23,
  minGapMs: 6 * 3600000,
  maxGapMs: 72 * 3600000,
  dailyCap: 2,
  mode: 'template',
  jitter: 0.2,
}
// 交友目标：每天要认识几个新朋友；没达标就按间隔提醒各总台去聊
const DEFAULT_GOAL = {
  enabled: false,
  min: 3,
  max: 8,
  remindEveryMs: 2 * 3600000,
  dailyCap: 3,
  dayKey: '',
  sentToday: 0,
  lastRemindAt: 0,
}

const emptyDb = () => ({
  version: SCHEMA_VERSION,
  friends: [],
  bridges: [],
  pendingSenders: [],
  holds: [],
  outbox: [],
  messages: [],
  activations: [],
  settings: {
    shareLimit: 1,
    routing: { ...DEFAULT_ROUTING },
    rate: { ...DEFAULT_RATE },
    proactive: { ...DEFAULT_PROACTIVE },
    goal: { ...DEFAULT_GOAL },
  },
})

const MAX_ACTIVATIONS = 20
const MAX_BRIDGES = 20
const MAX_PENDING = 100
const MAX_HOLDS = 200
const MAX_OUTBOX = 200
const MAX_MESSAGES = 300

/** 激活队列：host 侧请求「切到某个朋友的会话」，客户端面板/浮层轮询取走。 */
function normalizeActivations(raw) {
  return asArray(raw)
    .filter((a) => a && typeof a === 'object' && str(a.sessionId).trim())
    .map((a) => ({
      id: str(a.id).trim() || newId(),
      friendId: str(a.friendId),
      friendName: str(a.friendName),
      sessionId: str(a.sessionId).trim(),
      kind: str(a.kind) || 'dsh',
      note: str(a.note),
      at: Number(a.at) || now(),
      acked: a.acked === true,
      ackedAt: Number(a.ackedAt) || 0,
    }))
    .slice(-MAX_ACTIVATIONS)
}

let idSeq = 0
export function newId() {
  idSeq = (idSeq + 1) % 0xffff
  return `f_${now().toString(36)}_${idSeq.toString(36)}${crypto.randomBytes(2).toString('hex')}`
}

const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 一个桥接：外来消息从哪来、出去的消息往哪送。 */
function normalizeBridge(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = { ...raw }
  b.id = str(b.id).trim() || `b_${index + 1}_${crypto.randomBytes(2).toString('hex')}`
  b.name = str(b.name).trim() || b.id
  b.kind = str(b.kind).trim() || 'file'
  b.enabled = b.enabled !== false
  b.config = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? { ...b.config } : {}
  b.createdAt = Number(b.createdAt) || now()
  b.lastInAt = Number(b.lastInAt) || 0
  b.lastOutAt = Number(b.lastOutAt) || 0
  b.stats = b.stats && typeof b.stats === 'object' ? b.stats : {}
  b.stats.in = Number(b.stats.in) || 0
  b.stats.out = Number(b.stats.out) || 0
  b.stats.errors = Number(b.stats.errors) || 0
  return b
}

/** 陌生人计数器：同一桥接同一 uid 数够 promoteAfter 次就自动建档。 */
function normalizePending(raw) {
  return asArray(raw)
    .filter((p) => p && typeof p === 'object' && str(p.key).trim())
    .map((p) => ({
      key: str(p.key).trim(),
      bridgeId: str(p.bridgeId).trim(),
      uid: str(p.uid).trim(),
      name: str(p.name).trim(),
      count: Math.max(0, Number(p.count) || 0),
      firstAt: Number(p.firstAt) || now(),
      lastAt: Number(p.lastAt) || now(),
      // 建档进行中的标记（防止同一个人被并发建两份档案）
      promoting: Number(p.promoting) || 0,
      samples: asArray(p.samples)
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({ at: Number(s.at) || 0, text: str(s.text).slice(0, 200) }))
        .slice(-3),
    }))
    .slice(-MAX_PENDING)
}

/** 被限流暂存的消息（窗口过了再决定投不投）。 */
function normalizeHolds(raw) {
  return asArray(raw)
    .filter((h) => h && typeof h === 'object' && str(h.text).trim())
    .map((h) => ({
      id: str(h.id).trim() || newId(),
      friendId: str(h.friendId),
      friendName: str(h.friendName),
      bridgeId: str(h.bridgeId),
      uid: str(h.uid),
      text: str(h.text).slice(0, 4000),
      at: Number(h.at) || now(),
      reason: str(h.reason) || 'rate-limit',
    }))
    .slice(-MAX_HOLDS)
}

/** 出站队列：发不出去的消息留着重试。 */
function normalizeOutbox(raw) {
  return asArray(raw)
    .filter((o) => o && typeof o === 'object' && str(o.text).trim())
    .map((o) => ({
      id: str(o.id).trim() || newId(),
      at: Number(o.at) || now(),
      bridgeId: str(o.bridgeId).trim(),
      to: str(o.to).trim(),
      name: str(o.name),
      text: str(o.text).slice(0, 4000),
      kind: str(o.kind) || 'reply',
      status: ['pending', 'sent', 'failed'].includes(str(o.status)) ? str(o.status) : 'pending',
      tries: Math.max(0, Number(o.tries) || 0),
      error: str(o.error).slice(0, 300),
      sentAt: Number(o.sentAt) || 0,
    }))
    .slice(-MAX_OUTBOX)
}

/** 路由审计：最近进出的消息，面板「消息流」用它。 */
function normalizeMessages(raw) {
  return asArray(raw)
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      id: str(m.id).trim() || newId(),
      at: Number(m.at) || now(),
      dir: str(m.dir) === 'out' ? 'out' : 'in',
      bridgeId: str(m.bridgeId),
      friendId: str(m.friendId),
      name: str(m.name),
      text: str(m.text).slice(0, 2000),
      route: ['shared', 'dedicated', 'held', 'dropped', 'pending', 'out', 'invited'].includes(str(m.route)) ? str(m.route) : 'shared',
      note: str(m.note).slice(0, 300),
    }))
    .slice(-MAX_MESSAGES)
}

function normalizeSharedSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const ref = str(raw.ref).trim()
  if (!ref) return null
  return {
    id: str(raw.id).trim() || newId(),
    kind: str(raw.kind) || 'dsh',
    ref,
    label: str(raw.label).trim(),
    enabled: raw.enabled !== false,
    goal: raw.goal !== false,
    createdAt: Number(raw.createdAt) || now(),
    lastAt: Number(raw.lastAt) || 0,
  }
}

/** 多总台：顺手把 0.4 的单个 routing.sharedSession 迁移成数组第一项。 */
function normalizeSharedSessions(raw, legacy) {
  let list = asArray(raw).map(normalizeSharedSession).filter(Boolean)
  if (!list.length && legacy && typeof legacy === 'object') {
    const one = normalizeSharedSession(legacy)
    if (one) list = [one]
  }
  const seen = new Set()
  list = list.filter((x) => {
    if (seen.has(x.ref)) return false
    seen.add(x.ref)
    return true
  })
  return list.slice(-10)
}

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  s.shareLimit = clampInt(s.shareLimit, 1, 50, 1)
  const routing = s.routing && typeof s.routing === 'object' ? { ...s.routing } : {}
  const p2p = routing.publicToPrivate && typeof routing.publicToPrivate === 'object' ? { ...routing.publicToPrivate } : {}
  s.routing = {
    promoteAfter: clampInt(routing.promoteAfter, 1, 20, DEFAULT_ROUTING.promoteAfter),
    sharedSessions: normalizeSharedSessions(routing.sharedSessions, routing.sharedSession),
    workspaceDir: str(routing.workspaceDir).trim(),
    publicToPrivate: {
      enabled: p2p.enabled === true,
      afterMessages: clampInt(p2p.afterMessages, 1, 20, DEFAULT_ROUTING.publicToPrivate.afterMessages),
      cooldownMs: clampInt(p2p.cooldownMs, 3600000, 7 * 86400000, DEFAULT_ROUTING.publicToPrivate.cooldownMs),
      opener: str(p2p.opener).slice(0, 200),
    },
  }
  const rate = s.rate && typeof s.rate === 'object' ? { ...s.rate } : {}
  s.rate = {
    windowMs: clampInt(rate.windowMs, 60000, 7 * 86400000, DEFAULT_RATE.windowMs),
    max: clampInt(rate.max, 1, 1000, DEFAULT_RATE.max),
  }
  const p = s.proactive && typeof s.proactive === 'object' ? { ...s.proactive } : {}
  s.proactive = {
    enabled: p.enabled === true,
    windowFrom: clampInt(p.windowFrom, 0, 23, DEFAULT_PROACTIVE.windowFrom),
    windowTo: clampInt(p.windowTo, 0, 23, DEFAULT_PROACTIVE.windowTo),
    minGapMs: clampInt(p.minGapMs, 5 * 60000, 30 * 86400000, DEFAULT_PROACTIVE.minGapMs),
    maxGapMs: clampInt(p.maxGapMs, 5 * 60000, 30 * 86400000, DEFAULT_PROACTIVE.maxGapMs),
    dailyCap: clampInt(p.dailyCap, 0, 50, DEFAULT_PROACTIVE.dailyCap),
    mode: ['template', 'agent'].includes(str(p.mode)) ? str(p.mode) : 'template',
    jitter: Math.min(0.9, Math.max(0, Number(p.jitter) || 0)),
  }
  if (s.proactive.maxGapMs < s.proactive.minGapMs) s.proactive.maxGapMs = s.proactive.minGapMs
  const g = s.goal && typeof s.goal === 'object' ? { ...s.goal } : {}
  s.goal = {
    enabled: g.enabled === true,
    min: clampInt(g.min, 0, 50, DEFAULT_GOAL.min),
    max: clampInt(g.max, 0, 50, DEFAULT_GOAL.max),
    remindEveryMs: clampInt(g.remindEveryMs, 15 * 60000, 24 * 3600000, DEFAULT_GOAL.remindEveryMs),
    dailyCap: clampInt(g.dailyCap, 0, 20, DEFAULT_GOAL.dailyCap),
    dayKey: str(g.dayKey).slice(0, 10),
    sentToday: Math.max(0, Number(g.sentToday) || 0),
    lastRemindAt: Number(g.lastRemindAt) || 0,
  }
  if (s.goal.max < s.goal.min) s.goal.max = s.goal.min
  return s
}

function asArray(v) {
  return Array.isArray(v) ? v : []
}

function str(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

/** 把任意一条数据改成「至少不会让后面崩」的形状；返回 null 表示这条没法救、丢弃。 */
function normalizeFriend(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const f = { ...raw }
  f.name = str(f.name).trim()
  if (!f.name) {
    f.name = `未命名-${index + 1}`
    f._needsName = true
  }
  f.id = str(f.id).trim() || newId()
  f.aliases = asArray(f.aliases).map((x) => str(x).trim()).filter(Boolean)
  f.interests = asArray(f.interests).map((x) => str(x).trim()).filter(Boolean)
  if (!f.interests.length && Array.isArray(f.tags)) f.interests = f.tags.map((x) => str(x).trim()).filter(Boolean)
  f.channels = asArray(f.channels)
    .filter((c) => c && typeof c === 'object' && str(c.platform).trim())
    .map((c) => ({ platform: str(c.platform).trim(), uid: str(c.uid), kind: str(c.kind) || '会话' }))
  if (!f.channels.length && f.platform) {
    f.channels = [{ platform: str(f.platform), uid: str(f.uid), kind: str(f.platform) === 'bilibili' ? '私信' : '会话' }]
  }
  f.log = asArray(f.log)
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({
      at: Number(l.at) || 0,
      kind: str(l.kind) || 'talk',
      text: str(l.text),
      ...(l.mood ? { mood: str(l.mood) } : {}),
      ...(l.kind === 'share' ? { sent: l.sent === true } : {}),
    }))
    .slice(-80)
  // 会话：给这个朋友安排的对话/操作上下文（和「联系通道」不是一回事）
  if (f.session && typeof f.session === 'object') {
    const kind = str(f.session.kind) || 'dsh'
    const ref = str(f.session.ref)
    f.session = ref ? { kind, ref, label: str(f.session.label) } : undefined
  } else {
    f.session = undefined
  }
  // 交接记忆投过哪个会话（同一会话不再重复投）
  if (f.briefed && typeof f.briefed === 'object' && str(f.briefed.sessionRef)) {
    f.briefed = { sessionRef: str(f.briefed.sessionRef), at: Number(f.briefed.at) || 0 }
  } else {
    f.briefed = undefined
  }
  f.impression = str(f.impression)
  f.createdAt = Number(f.createdAt) || now()
  f.updatedAt = Number(f.updatedAt) || f.createdAt
  f.lastTalkAt = Number(f.lastTalkAt) || 0
  // 上次从公共场合把 TA 拉进私聊的时间（防重复邀请）
  f.lastPrivateInviteAt = Number(f.lastPrivateInviteAt) || 0
  f.autoCreated = f.autoCreated === true
  f.sourceBridge = str(f.sourceBridge)
  // 专属会话限流（覆盖全局）：不填就用 settings.rate
  if (f.limits && typeof f.limits === 'object') {
    f.limits = {
      windowMs: Number(f.limits.windowMs) > 0 ? clampInt(f.limits.windowMs, 60000, 7 * 86400000, 3600000) : 0,
      max: Number(f.limits.max) > 0 ? clampInt(f.limits.max, 1, 1000, 30) : 0,
    }
  } else {
    f.limits = undefined
  }
  // 主动找人聊：不填就继承全局（enabled 例外，默认关）
  if (f.proactive && typeof f.proactive === 'object') {
    const p = f.proactive
    f.proactive = {
      enabled: p.enabled === true,
      ...(p.windowFrom !== undefined ? { windowFrom: clampInt(p.windowFrom, 0, 23, 9) } : {}),
      ...(p.windowTo !== undefined ? { windowTo: clampInt(p.windowTo, 0, 23, 23) } : {}),
      ...(p.dailyCap !== undefined ? { dailyCap: clampInt(p.dailyCap, 0, 50, 2) } : {}),
      ...(p.mode ? { mode: ['template', 'agent'].includes(str(p.mode)) ? str(p.mode) : 'template' } : {}),
      lastProactiveAt: Number(p.lastProactiveAt) || 0,
    }
  } else {
    f.proactive = undefined
  }
  return f
}

function normalizeDb(parsed, meta) {
  const warnings = meta.warnings
  const db = { ...parsed }
  const friends = asArray(parsed.friends)
  const out = []
  let dropped = 0
  friends.forEach((raw, i) => {
    const f = normalizeFriend(raw, i)
    if (f) out.push(f)
    else dropped += 1
  })
  if (dropped) warnings.push(`数据里有 ${dropped} 条鱼友不是对象，已跳过（原文件还在）`)
  const ids = new Set()
  for (const f of out) {
    let id = f.id
    while (ids.has(id)) id = newId()
    ids.add(id)
    f.id = id
  }
  db.friends = out
  const bridges = []
  asArray(parsed.bridges).forEach((raw, i) => {
    const b = normalizeBridge(raw, i)
    if (b) bridges.push(b)
  })
  db.bridges = bridges.slice(-MAX_BRIDGES)
  db.pendingSenders = normalizePending(parsed.pendingSenders)
  db.holds = normalizeHolds(parsed.holds)
  db.outbox = normalizeOutbox(parsed.outbox)
  db.messages = normalizeMessages(parsed.messages)
  db.activations = normalizeActivations(parsed.activations)
  db.settings = normalizeSettings(parsed.settings)
  const fromVersion = Number(parsed.version) || 1
  if (fromVersion > SCHEMA_VERSION) warnings.push(`数据文件版本 ${fromVersion} 比插件版本 ${SCHEMA_VERSION} 新，已按兼容方式读取`)
  db.version = SCHEMA_VERSION
  return db
}

function parseFile(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return JSON.parse(clean)
}

/**
 * 读取数据。永不抛异常、永不悄悄清空：
 * - 文件不存在 → status:'missing'
 * - JSON 坏了 → 先把原文件复制成 friends.corrupt-<时间>.json，再返回空库，status:'corrupt'
 */
export function readDb() {
  const file = dataFile()
  const meta = { status: 'ok', error: '', warnings: [], file }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      meta.status = 'missing'
      return { db: emptyDb(), ...meta }
    }
    meta.status = 'error'
    meta.error = e instanceof Error ? e.message : String(e)
    return { db: emptyDb(), ...meta }
  }
  let parsed
  try {
    parsed = parseFile(text)
  } catch (e) {
    meta.status = 'corrupt'
    meta.error = e instanceof Error ? e.message : String(e)
    try {
      fs.mkdirSync(homeDir(), { recursive: true })
      const copy = corruptFile(stamp())
      fs.copyFileSync(file, copy)
      meta.corruptCopy = copy
      meta.warnings.push(`数据文件坏了（${meta.error}），原文件已备份到 ${copy}，本次按空库继续；下次保存不会覆盖那份备份`)
    } catch (copyError) {
      meta.warnings.push(`数据文件坏了（${meta.error}），而且备份失败：${copyError instanceof Error ? copyError.message : copyError}`)
    }
    return { db: emptyDb(), ...meta }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    meta.status = 'corrupt'
    meta.error = '顶层不是对象'
    meta.warnings.push('数据文件格式不对（顶层不是对象），已按空库继续')
    return { db: emptyDb(), ...meta }
  }
  return { db: normalizeDb(parsed, meta), ...meta }
}

/** 原子保存：先写临时文件，再把旧文件复制成 .bak，最后替换。 */
export function writeDb(db) {
  fs.mkdirSync(homeDir(), { recursive: true })
  const file = dataFile()
  const tmp = path.join(homeDir(), `.friends.${process.pid}.${Date.now()}.tmp`)
  db.version = SCHEMA_VERSION
  const body = JSON.stringify(db, null, 2)
  fs.writeFileSync(tmp, body, 'utf8')
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, backupFile())
  } catch {
    // 备份失败不影响主写入
  }
  fs.renameSync(tmp, file)
}

// 同一进程内的写操作串行化（插件是单进程，足够挡住并发工具调用）。
let queue = Promise.resolve()
function serialized(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 只读：read(fn)；写：mutate(fn)，fn 正常返回才会落盘。 */
export function read(fn) {
  return serialized(() => {
    const r = readDb()
    return fn(r.db, r)
  })
}

export function mutate(fn) {
  return serialized(() => {
    const r = readDb()
    const out = fn(r.db, r)
    if (out && out.noSave === true) return out.value
    writeDb(r.db)
    return out && Object.prototype.hasOwnProperty.call(out, 'value') ? out.value : out
  })
}

/** 精确匹配：名字 / id / 别名。 */
export function findExact(db, q) {
  const key = norm(q)
  if (!key) return null
  const byName = db.friends.find((f) => norm(f.name) === key)
  if (byName) return { friend: byName, how: 'name' }
  const byId = db.friends.find((f) => norm(f.id) === key)
  if (byId) return { friend: byId, how: 'id' }
  const byAlias = db.friends.find((f) => (f.aliases || []).some((a) => norm(a) === key))
  if (byAlias) return { friend: byAlias, how: 'alias' }
  return null
}

/** 解析名字：先精确，再模糊。模糊有歧义时返回候选，不瞎选。 */
export function resolve(db, q) {
  const key = norm(q)
  if (!key) return { friend: null, how: 'empty', candidates: [] }
  const exact = findExact(db, q)
  if (exact) return { friend: exact.friend, how: exact.how, candidates: [] }
  const hits = db.friends.filter((f) => norm(f.name).includes(key) || key.includes(norm(f.name)))
  const aliasHits = db.friends.filter((f) => (f.aliases || []).some((a) => norm(a).includes(key)))
  const all = [...new Set([...hits, ...aliasHits])]
  if (all.length === 1) return { friend: all[0], how: 'fuzzy', candidates: [] }
  return { friend: null, how: all.length ? 'ambiguous' : 'none', candidates: all }
}

export function idOf(f) {
  return f && f.id ? f.id : ''
}

export const limits = { MAX_ACTIVATIONS, MAX_BRIDGES, MAX_PENDING, MAX_HOLDS, MAX_OUTBOX, MAX_MESSAGES }
export const defaults = { routing: DEFAULT_ROUTING, rate: DEFAULT_RATE, proactive: DEFAULT_PROACTIVE, goal: DEFAULT_GOAL }

/** 造一条总台配置（多个总台按 lastAt 轮流接陌生人）。 */
export function newSharedSession({ ref, label = '', kind = 'dsh', goal = true } = {}) {
  const r = str(ref).trim()
  if (!r) return null
  return { id: newId(), kind: str(kind) || 'dsh', ref: r, label: str(label).trim(), enabled: true, goal: goal !== false, createdAt: now(), lastAt: 0 }
}

/** 文件名安全化：好友/桥接 id 里可能有奇怪字符。 */
export const safeName = (s) =>
  String(s ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/, '')
    .slice(0, 80) || 'x'

/** 桥接的本地目录：file 桥在这里收发 jsonl。 */
export const bridgeDir = (id) => path.join(homeDir(), 'bridges', safeName(id))

/** 每个朋友的专属工作区（自动建档时用它当会话 cwd）。 */
export const workspaceFor = (friend) =>
  path.join(homeDir(), 'workspaces', `${safeName(friend?.name || 'friend')}-${safeName(friend?.id || '')}`.slice(0, 100))

export const workspaceRoot = () => path.join(homeDir(), 'workspaces')
