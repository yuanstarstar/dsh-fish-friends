// 主动闲聊：机器人「闲着无聊」时按时间段 + 亲密度决定频率去找朋友说话。
//
// 规则：
//   - 全局开关 settings.proactive.enabled 是总闸；每个朋友还要 friend.proactive.enabled=true 才会被找。
//   - 只在 settings.proactive.windowFrom ~ windowTo（本地小时）之间活动，支持跨夜（from > to）。
//   - 频率由亲密度决定：spacing = maxGap - (maxGap-minGap) * affinity/100，再叠加 ±jitter 抖动。
//     亲密度越高越勤（spacing 越短）。
//   - 每人每天最多 dailyCap 条（0 = 不主动）。
//   - mode='template' 用本地话术模板发（不花 token）；mode='agent' 让她的专属会话自己想一句再发。
import { read, mutate, newId } from './store.js'
import { affinity, DAY } from './score.js'
import { effectiveRate } from './routing.js'
import { promptSession } from './session.js'

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 合并全局与个人设置：返回这个朋友「该怎么被找」。 */
export function proactiveConfig(db, friend) {
  const g = db?.settings?.proactive || {}
  const p = friend?.proactive || {}
  return {
    enabled: g.enabled === true && p.enabled === true,
    windowFrom: p.windowFrom ?? g.windowFrom ?? 9,
    windowTo: p.windowTo ?? g.windowTo ?? 23,
    minGapMs: g.minGapMs || 6 * 3600000,
    maxGapMs: g.maxGapMs || 72 * 3600000,
    dailyCap: p.dailyCap ?? g.dailyCap ?? 2,
    mode: p.mode || g.mode || 'template',
    jitter: Number.isFinite(g.jitter) ? g.jitter : 0.2,
  }
}

/** 这个人的目标间隔：亲密度 0 → maxGap，亲密度 100 → minGap。 */
export function targetGapMs(db, friend) {
  const c = proactiveConfig(db, friend)
  const a = clamp(affinity(friend), 0, 100) / 100
  return Math.round(c.maxGapMs - (c.maxGapMs - c.minGapMs) * a)
}

/** 加抖动后的间隔（按朋友 id + 日期做种子，同一天多次调用结果稳定）。 */
export function jitteredGapMs(db, friend, at = Date.now()) {
  const base = targetGapMs(db, friend)
  const j = proactiveConfig(db, friend).jitter
  if (!j) return base
  const seed = `${friend?.id || ''}:${new Date(at).toDateString()}`
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const unit = ((h >>> 0) % 1000) / 1000 // 0..1
  const factor = 1 + (unit * 2 - 1) * j // 1 ± jitter
  return Math.max(60000, Math.round(base * factor))
}

export function inWindow(c, at = Date.now()) {
  const hour = new Date(at).getHours()
  const from = Number(c.windowFrom)
  const to = Number(c.windowTo)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return true
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

function startOfDay(at) {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 今天已经主动发过几条。 */
export function proactiveSentToday(db, friendId, at = Date.now()) {
  const from = startOfDay(at)
  return (db.messages || []).filter(
    (m) => m.dir === 'out' && m.friendId === friendId && m.note === 'proactive' && Number(m.at) >= from,
  ).length
}

/** 最近一次「有来有回」的时间：聊天、收消息、发消息都算。 */
export function lastContactAt(db, friend) {
  let last = Number(friend?.lastTalkAt) || 0
  for (const m of db.messages || []) {
    if (m.friendId === friend?.id && Number(m.at) > last) last = Number(m.at)
  }
  return last
}

const TEMPLATES = {
  withInterest: [
    '刚看到点跟「{interest}」有关的，想到你了。最近还在玩这个吗？',
    '哎，你又神隐了。最近有没有新的「{interest}」可以安利给我的？',
    '突然想起来问问，你那个「{interest}」的坑填完了没？',
  ],
  generic: [
    '在忙吗？我闲着有点无聊，来冒个泡。',
    '今天过得怎么样？没什么事，就是想跟你说句话。',
    '突然想起你。最近还好吗？',
    '喂，还活着吗？好久没听你说话了。',
  ],
}

/** 用本地模板拼一句（mode=template，不花 token）。 */
export function templateMessage(friend, at = Date.now()) {
  const interests = Array.isArray(friend?.interests) ? friend.interests.filter(Boolean) : []
  const pool = interests.length ? TEMPLATES.withInterest : TEMPLATES.generic
  const pick = pool[(Math.floor(at / 60000) + String(friend?.id || '').length) % pool.length]
  const interest = interests.length ? interests[Math.floor(at / 60000) % interests.length] : ''
  return pick.replace('{interest}', interest || '那个')
}

/** 该主动找谁：返回 [{friend, gap, lastContactAt, reason}]，按「超时最久」排序。 */
export function dueProactive(db, at = Date.now()) {
  const out = []
  for (const friend of db.friends || []) {
    const c = proactiveConfig(db, friend)
    if (!c.enabled) continue
    if (!inWindow(c, at)) continue
    if (!friend?.session?.ref) continue // 没专属会话就没地方「找」，也不该硬塞总台
    const cap = Math.max(0, Number(c.dailyCap) || 0)
    if (cap === 0) continue
    if (proactiveSentToday(db, friend.id, at) >= cap) continue
    const gap = jitteredGapMs(db, friend, at)
    const last = lastContactAt(db, friend)
    const idle = at - last
    if (idle < gap) continue
    out.push({ friend, gap, lastContactAt: last, idle, reason: `已经 ${Math.round(idle / 3600000)} 小时没动静（间隔 ${Math.round(gap / 3600000)}h）` })
  }
  out.sort((x, y) => y.idle / y.gap - x.idle / x.gap)
  return out
}

/**
 * 跑一次主动闲聊检查。返回 {checked, sent: [{name, ok, error}], skipped}
 * 由 host 定时器每 60s 调一次。
 */
export async function tickProactive(ctx, { maxPerTick = 3, at = Date.now() } = {}) {
  const snap = await read((db) => ({ db, due: dueProactive(db, at).slice(0, maxPerTick) }))
  if (!snap.due.length) return { checked: 0, sent: [], skipped: 0 }
  const sent = []
  for (const item of snap.due) {
    const friend = item.friend
    const c = proactiveConfig(snap.db, friend)
    const target = friend.session?.ref || ''
    let ok = false
    let error = ''
    if (c.mode === 'agent') {
      const instruction = `你有点闲，想找「${friend.name}」聊两句。用 friends_send（name="${friend.name}"）发一句自然、简短的话，别超过 40 字。发完就结束，不要解释。`
      const r = await promptSession(ctx, target, instruction)
      ok = r.ok === true
      error = r.error || ''
      if (ok) {
        await mutate((db) => {
          const f = (db.friends || []).find((x) => x.id === friend.id)
          if (f) {
            f.proactive = { ...(f.proactive || {}), enabled: true, lastProactiveAt: at }
            f.updatedAt = at
          }
          db.messages = Array.isArray(db.messages) ? db.messages : []
          db.messages.push({
            id: newId(),
            at,
            dir: 'out',
            bridgeId: '',
            friendId: friend.id,
            name: friend.name,
            text: '（让专属会话自己找 TA 聊天）',
            route: 'out',
            note: 'proactive',
          })
          if (db.messages.length > 300) db.messages = db.messages.slice(-300)
          return undefined
        })
      }
    } else {
      const { sendToFriend } = await import('./routing.js')
      const r = await sendToFriend(ctx, snap.db, friend, templateMessage(friend, at), { kind: 'proactive' })
      ok = r.ok === true
      error = r.error || ''
      if (ok) {
        await mutate((db) => {
          const f = (db.friends || []).find((x) => x.id === friend.id)
          if (f) {
            f.proactive = { ...(f.proactive || {}), enabled: true, lastProactiveAt: at }
            f.updatedAt = at
          }
          // sendToFriend 已经写了一条 message，这里把它标成 proactive，方便统计「今天发了几条」
          const rows = (db.messages || []).filter((m) => m.dir === 'out' && m.friendId === friend.id)
          const last = rows[rows.length - 1]
          if (last && Number(last.at) >= at - 5000) last.note = 'proactive'
          return undefined
        })
      }
    }
    sent.push({ name: friend.name, ok, error })
  }
  return { checked: snap.due.length, sent, skipped: 0 }
}

/** 下次大概什么时候会找谁（给面板/工具看）。 */
export function nextDuePreview(db, at = Date.now(), limit = 10) {
  const rows = []
  for (const friend of db.friends || []) {
    const c = proactiveConfig(db, friend)
    if (!c.enabled || !friend?.session?.ref) continue
    const gap = jitteredGapMs(db, friend, at)
    const last = lastContactAt(db, friend)
    const nextAt = Math.max(at, last + gap)
    rows.push({
      name: friend.name,
      affinity: affinity(friend),
      gapHours: Math.round(gap / 3600000),
      nextAt,
      withinWindow: inWindow(c, nextAt),
      sentToday: proactiveSentToday(db, friend.id, at),
      dailyCap: c.dailyCap,
    })
  }
  rows.sort((a, b) => a.nextAt - b.nextAt)
  return rows.slice(0, limit)
}

export const _internal = { startOfDay, DAY, newId, effectiveRate, str }
