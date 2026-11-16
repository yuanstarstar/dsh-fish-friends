// 作息分析：用「和这个人的消息流 + 互动日志」估计 TA 常出没的时段。
// 纯统计，不调模型；面板和工具都读这里，避免两套算法。
import { now as clock } from './store.js'

const DAY = 86400000
const HOUR = 3600000

function hourOf(at) {
  return new Date(at).getHours()
}

function clampDays(d) {
  const n = Number(d)
  if (!Number.isFinite(n) || n <= 0) return 30
  return Math.min(365, Math.round(n))
}

/** 把 [20,21,22,23,1] 这类小时列表压成「20:00-23:00、01:00」这种可读文本。 */
export function hoursText(hours) {
  const list = [...new Set(hours.filter((h) => Number.isFinite(h) && h >= 0 && h < 24))].sort((a, b) => a - b)
  if (!list.length) return ''
  const parts = []
  let start = list[0]
  let prev = list[0]
  for (let i = 1; i < list.length; i += 1) {
    if (list[i] === prev + 1) {
      prev = list[i]
      continue
    }
    parts.push(start === prev ? `${String(start).padStart(2, '0')}:00` : `${String(start).padStart(2, '0')}:00-${String(prev + 1).padStart(2, '0')}:00`)
    start = list[i]
    prev = list[i]
  }
  parts.push(start === prev ? `${String(start).padStart(2, '0')}:00` : `${String(start).padStart(2, '0')}:00-${String(prev + 1).padStart(2, '0')}:00`)
  return parts.join('、')
}

/**
 * 分析一个朋友的作息。
 * 返回 { ok, friendId, friendName, days, total, byHour[24], activeHours[], peakHour, peakCount,
 *        avgGapMs, lastAt, text }
 */
export function analyzeRhythm(db, friend, { days = 30, at = clock() } = {}) {
  if (!friend || !friend.id) return { ok: false, error: '没有这个人' }
  const span = clampDays(days)
  const from = at - span * DAY
  const byHour = new Array(24).fill(0)
  let total = 0
  let firstAt = 0
  let lastAt = 0

  const bump = (t) => {
    if (!t || t < from || t > at) return
    byHour[hourOf(t)] += 1
    total += 1
    if (!firstAt || t < firstAt) firstAt = t
    if (t > lastAt) lastAt = t
  }

  for (const m of Array.isArray(db?.messages) ? db.messages : []) {
    if (!m || m.friendId !== friend.id) continue
    bump(Number(m.at) || 0)
  }
  for (const l of Array.isArray(friend.log) ? friend.log : []) {
    bump(Number(l?.at) || 0)
  }

  const peakCount = Math.max(0, ...byHour)
  const peakHour = total > 0 ? byHour.indexOf(peakCount) : -1
  // 活跃时段：达到峰值 20% 的小时（至少 1 条）
  const floor = Math.max(1, Math.ceil(peakCount * 0.2))
  const activeHours = []
  for (let h = 0; h < 24; h += 1) if (byHour[h] >= floor) activeHours.push(h)
  const avgGapMs = total > 1 && lastAt > firstAt ? Math.round((lastAt - firstAt) / (total - 1)) : 0
  const text = total
    ? `近 ${span} 天有 ${total} 次互动，常出没 ${hoursText(activeHours) || '时段很散'}${peakHour >= 0 ? `（高峰 ${String(peakHour).padStart(2, '0')}:00）` : ''}`
    : `近 ${span} 天没有互动记录，作息还看不出来`

  return {
    ok: true,
    friendId: friend.id,
    friendName: friend.name,
    days: span,
    total,
    byHour,
    activeHours,
    peakHour,
    peakCount,
    avgGapMs,
    firstAt,
    lastAt,
    text,
  }
}

/** 一行的短描述，给面板卡片用。 */
export function rhythmLine(a) {
  if (!a || !a.ok || !a.total) return ''
  return `常出没 ${hoursText(a.activeHours)}`
}

/** 现在是不是 TA 通常活跃的时段。 */
export function activeNow(a, at = clock()) {
  if (!a || !a.ok || !a.activeHours?.length) return false
  return a.activeHours.includes(hourOf(at))
}

/** 下一次 TA 可能在线的时间（按活跃小时往后推，最多找 7 天）。 */
export function nextActiveAt(a, at = clock()) {
  if (!a || !a.ok || !a.activeHours?.length) return 0
  const base = new Date(at)
  base.setMinutes(0, 0, 0)
  for (let i = 0; i < 24 * 7; i += 1) {
    const t = base.getTime() + i * HOUR
    if (t > at && a.activeHours.includes(new Date(t).getHours())) return t
  }
  return 0
}

export const _internal = { hourOf, clampDays, DAY, HOUR }
