// 交友目标：每天要认识几个新朋友；没达标就按间隔提醒各总台会话去聊。
// 「认识新朋友」= 今天新建档 / 今天第一次 upsert 记进来的人（按 friend.createdAt）。
import { read, mutate } from './store.js'
import { promptSession } from './session.js'

export const GOAL_ACTIVE_FROM = 8
export const GOAL_ACTIVE_TO = 23

export function dayStart(at = Date.now()) {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayKeyOf(at = Date.now()) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function goalConfig(db) {
  const g = db?.settings?.goal && typeof db.settings.goal === 'object' ? db.settings.goal : {}
  return {
    enabled: g.enabled === true,
    min: Math.max(0, Number(g.min) || 0),
    max: Math.max(0, Number(g.max) || 0),
    remindEveryMs: Math.max(60000, Number(g.remindEveryMs) || 2 * 3600000),
    dailyCap: Math.max(0, Number(g.dailyCap) || 0),
    dayKey: String(g.dayKey || ''),
    sentToday: Math.max(0, Number(g.sentToday) || 0),
    lastRemindAt: Number(g.lastRemindAt) || 0,
  }
}

/** 所有启用中的总台会话。 */
export function sharedSessionsOf(db, { forGoal = false } = {}) {
  const list = Array.isArray(db?.settings?.routing?.sharedSessions) ? db.settings.routing.sharedSessions : []
  const live = list.filter((s) => s && String(s.ref || '').trim() && s.enabled !== false)
  return forGoal ? live.filter((s) => s.goal !== false) : live
}

export function newFriendsToday(db, at = Date.now()) {
  const start = dayStart(at)
  const list = Array.isArray(db?.friends) ? db.friends : []
  return list.filter((f) => {
    const t = Number(f?.createdAt) || 0
    return t >= start && t <= at
  })
}

export function goalStatus(db, at = Date.now()) {
  const g = goalConfig(db)
  const key = dayKeyOf(at)
  const today = newFriendsToday(db, at)
  const shared = sharedSessionsOf(db, { forGoal: true })
  const sharedAll = sharedSessionsOf(db)
  const sentToday = g.dayKey === key ? g.sentToday : 0
  const hour = new Date(at).getHours()
  const quiet = hour < GOAL_ACTIVE_FROM || hour >= GOAL_ACTIVE_TO
  const need = Math.max(0, g.min - today.length)
  const met = today.length >= g.min
  const nextRemindAt = g.lastRemindAt ? g.lastRemindAt + g.remindEveryMs : 0
  return {
    enabled: g.enabled,
    min: g.min,
    max: g.max,
    today: today.length,
    need,
    met,
    over: g.max > 0 && today.length > g.max,
    todayNames: today.slice(0, 5).map((f) => f.name),
    sharedCount: shared.length,
    sharedAll: sharedAll.length,
    remindEveryMin: Math.round(g.remindEveryMs / 60000),
    dailyCap: g.dailyCap,
    sentToday,
    lastRemindAt: g.lastRemindAt,
    nextRemindAt,
    quiet,
    quietFrom: GOAL_ACTIVE_FROM,
    quietTo: GOAL_ACTIVE_TO,
    dayKey: key,
    canRemind:
      g.enabled && !met && shared.length > 0 && !quiet && sentToday < g.dailyCap && !(nextRemindAt && nextRemindAt > at),
  }
}

/**
 * 到点提醒：给每个总台会话发一条「今天还差几个人」的指令。
 * force=true 时忽略时段/间隔/当日上限（面板「现在提醒一次」用）。
 */
export async function tickGoal(ctx, { at = Date.now(), force = false } = {}) {
  const snap = await read((db) => ({
    status: goalStatus(db, at),
    targets: sharedSessionsOf(db, { forGoal: true }).map((s) => ({ sessionId: String(s.ref), label: s.label || s.ref })),
  }))
  const st = snap.status
  if (!st.enabled) return { ok: true, skipped: '交友目标没开', status: st }
  if (st.met) return { ok: true, skipped: `今天已经认识 ${st.today} 位，达标了`, status: st }
  if (!snap.targets.length) return { ok: true, skipped: '还没有设置总台会话（friends_route 加一个）', status: st }
  if (!force) {
    if (st.quiet) return { ok: true, skipped: `现在是休息时段，${GOAL_ACTIVE_FROM}:00 之后才提醒`, status: st }
    if (st.sentToday >= st.dailyCap) return { ok: true, skipped: `今天已经提醒 ${st.sentToday} 次（上限 ${st.dailyCap}）`, status: st }
    if (st.nextRemindAt > at) {
      return { ok: true, skipped: `离下次提醒还有 ${Math.ceil((st.nextRemindAt - at) / 60000)} 分钟`, status: st }
    }
  }

  const range = st.max > st.min ? `${st.min}~${st.max}` : String(st.min)
  const text =
    `【鱼友簿 · 交友目标】今天的目标是认识 ${range} 位新朋友，现在已经认识 ${st.today} 位，还差 ${st.need} 位。` +
    '请主动去公共频道/群里找新朋友聊几句，聊到合适的人就用 friends_upsert 记下来（name + interests + 通道），别只挂在总台不说话。'

  const sent = []
  for (const t of snap.targets) {
    const r = await promptSession(ctx, t.sessionId, text)
    sent.push({ sessionId: t.sessionId, label: t.label, ok: r.ok === true, error: r.error || '' })
  }
  const okCount = sent.filter((s) => s.ok).length
  await mutate((db) => {
    db.settings.goal = db.settings.goal || {}
    const g = db.settings.goal
    const key = dayKeyOf(at)
    if (g.dayKey !== key) {
      g.dayKey = key
      g.sentToday = 0
    }
    if (okCount > 0) {
      g.sentToday = (Number(g.sentToday) || 0) + 1
      g.lastRemindAt = at
    }
    return undefined
  })
  const status = await read((db) => goalStatus(db, at))
  return { ok: okCount > 0, sent, status }
}

export function goalLine(st) {
  if (!st || !st.enabled) return '交友目标：未开启'
  const range = st.max > st.min ? `${st.min}~${st.max}` : String(st.min)
  return `交友目标：今天 ${st.today}/${range}${st.met ? '（已达标）' : `（还差 ${st.need} 位）`}`
}
