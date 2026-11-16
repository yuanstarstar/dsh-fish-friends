// 会话层 v2：和 DSH 真实的会话 API 对接。
// 事实（来自 docs/sessions-api.md，均带 DSH 源码行号）：
// - host 侧能列会话、建会话、往会话里投消息：ctx.sessionController.list / create / prompt
// - host 侧**没有**「切换当前会话」——切 UI 只能由客户端做：ctx.uiWorkspace.openSession(id)
// - 冷会话可以直接 prompt，内部会 resume；所以「发消息」本身就是一种唤醒
import crypto from 'node:crypto'

const now = () => Date.now()

function errorText(e) {
  if (!e) return '未知错误'
  const code = e.code || e.rpcError?.code
  const msg = e.message || String(e)
  return code ? `${code}: ${msg}` : msg
}

function serviceOf(ctx, name) {
  try {
    const svc = ctx?.[name]
    if (svc && typeof svc === 'object') return svc
  } catch {
    /* 服务没声明就跳过 */
  }
  return null
}

// 宿主没把 lifetime 注入给插件作用域时，ctx.lifetime 会抛
// `cannot get property "lifetime" without inject`。这里兜一层：
// 拿得到就复用宿主的 signal，拿不到就用一个永不 abort 的自有 signal。
const fallbackSignals = new WeakMap()

export function signalOf(ctx) {
  try {
    const s = ctx?.lifetime?.signal
    if (s && typeof s === 'object') return s
  } catch {
    /* 落在 fallback */
  }
  const key = ctx && (typeof ctx === 'object' || typeof ctx === 'function') ? ctx : null
  if (key) {
    const cached = fallbackSignals.get(key)
    if (cached) return cached
  }
  const signal = new AbortController().signal
  if (key) fallbackSignals.set(key, signal)
  return signal
}

function hostSegment(id) {
  const s = String(id || '').trim()
  return s.length > 0 ? s : ''
}

/** 这个朋友绑的会话是否可用（形状层，不查宿主）。 */
export function sessionBinding(friend) {
  const s = friend?.session
  if (!s || !s.ref) return { bound: false }
  return {
    bound: true,
    kind: String(s.kind || 'dsh'),
    ref: String(s.ref),
    label: String(s.label || ''),
  }
}

/** 列宿主可见的会话。宿主不支持时 ok:false，原因写清楚。 */
export async function listSessions(ctx) {
  const svc = serviceOf(ctx, 'sessionController')
  if (!svc || typeof svc.list !== 'function') {
    return { ok: false, reason: '当前宿主没有 sessionController（拿不到会话列表）', items: [] }
  }
  try {
    const res = await svc.list({}, signalOf(ctx))
    const items = Array.isArray(res?.items) ? res.items : []
    return { ok: true, items }
  } catch (e) {
    return { ok: false, reason: errorText(e), items: [] }
  }
}

/** 读会话标题；读不到返回 undefined（不是错误）。 */
export async function titleOf(ctx, sessionId) {
  const q = serviceOf(ctx, 'sessionQuery')
  if (!q || typeof q.readTitle !== 'function') return undefined
  try {
    const title = await q.readTitle(sessionId, signalOf(ctx))
    return typeof title === 'string' && title.trim() ? title.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 查一个朋友的会话现状：绑没绑、在不在、标题、是否在跑。
 * 面板和工具都用它，避免各写一套。
 */
export async function describeSession(ctx, friend) {
  const binding = sessionBinding(friend)
  if (!binding.bound) return { ...binding, exists: false, kind: '' }
  if (binding.kind !== 'dsh') {
    return { ...binding, exists: true, external: true }
  }
  const listed = await listSessions(ctx)
  if (!listed.ok) {
    return { ...binding, exists: null, lookupError: listed.reason }
  }
  const row = listed.items.find((item) => hostSegment(item?.sessionId) === binding.ref)
  if (!row) {
    return { ...binding, exists: false, lookupError: '会话列表里没有这一条（可能已删除或不在当前 profile）' }
  }
  const title = await titleOf(ctx, binding.ref)
  return {
    ...binding,
    exists: true,
    title,
    running: row.running === true,
    blank: row.blank === true,
    updatedAt: Number(row.updatedAt) || 0,
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
  }
}

/**
 * 往会话里投一条消息（会唤醒冷会话）。
 * mode='steer' 插到当前回合，默认 followup 排队。
 */
export async function promptSession(ctx, sessionId, text, { mode } = {}) {
  const svc = serviceOf(ctx, 'sessionController')
  if (!svc || typeof svc.prompt !== 'function') {
    return { ok: false, error: '当前宿主没有 sessionController.prompt（发不进去）' }
  }
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '消息是空的' }
  const requestId = crypto.randomUUID()
  try {
    const res = await svc.prompt(
      {
        sessionId: hostSegment(sessionId),
        requestId,
        content: [{ type: 'text', text: body }],
        ...(mode === 'steer' ? { mode: 'steer' } : {}),
      },
      signalOf(ctx),
    )
    return { ok: res?.accepted === true, requestId }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/** 新建一个 DSH 会话（仅 friends_session create:true 时显式使用）。 */
export async function createSession(ctx, { cwd } = {}) {
  const svc = serviceOf(ctx, 'sessionController')
  if (!svc || typeof svc.create !== 'function') {
    return { ok: false, error: '当前宿主没有 sessionController.create' }
  }
  try {
    const res = await svc.create(cwd ? { cwd } : {})
    const id = res?.sessionId
    if (!id) return { ok: false, error: '宿主没有返回会话 id' }
    return { ok: true, sessionId: String(id) }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/** 把「请切到会话」写进激活队列；客户端轮询到就会 openSession。 */
export function queueActivation(db, friend, { sessionId, note } = {}) {
  const id = String(sessionId || friend?.session?.ref || '').trim()
  if (!db || !id) return null
  db.activations = Array.isArray(db.activations) ? db.activations : []
  const existing = db.activations.find((a) => a && a.acked !== true && a.sessionId === id)
  if (existing) {
    if (note) existing.note = String(note)
    existing.at = now()
    return existing
  }
  const entry = {
    id: `a_${now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    friendId: String(friend?.id || ''),
    friendName: String(friend?.name || ''),
    sessionId: id,
    kind: String(friend?.session?.kind || 'dsh'),
    note: String(note || ''),
    at: now(),
    acked: false,
    ackedAt: 0,
  }
  db.activations.push(entry)
  if (db.activations.length > 20) db.activations = db.activations.slice(-20)
  return entry
}

/** 待客户端处理的激活请求。 */
export function pendingActivations(db) {
  const list = Array.isArray(db?.activations) ? db.activations : []
  return list.filter((a) => a && a.acked !== true)
}

export function ackActivations(db, ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)))
  const list = Array.isArray(db?.activations) ? db.activations : []
  let count = 0
  for (const a of list) {
    if (a && a.acked !== true && set.has(String(a.id))) {
      a.acked = true
      a.ackedAt = now()
      count += 1
    }
  }
  return count
}
