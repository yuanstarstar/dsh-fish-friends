// 打分与检索：亲密度、内容→人、关键词→人。纯函数，方便单测。
import { norm, now } from './store.js'

export const DAY = 86400000
export const daysSince = (ts) => (ts ? Math.floor((now() - ts) / DAY) : null)

/** 亲密度 0~100：互动次数 + 新鲜度 + 已发出分享（未发出的不算）。 */
export function affinity(f) {
  const log = f.log || []
  const talks = log.filter((l) => l.kind !== 'share').length
  const base = Math.min(55, talks * 8)
  const d = daysSince(f.lastTalkAt)
  const fresh = d === null ? 0 : Math.max(0, 40 - d * 2)
  const sent = log.filter((l) => l.kind === 'share' && l.sent === true).length
  const shared = Math.min(10, sent * 2)
  return Math.max(0, Math.min(100, Math.round(20 + base + fresh + shared)))
}

export function channelText(f) {
  return (f.channels || []).map((c) => `${c.platform} ${c.kind}${c.uid ? ` ${c.uid}` : ''}`).join(' / ')
}

export function sessionText(f) {
  const s = f.session
  if (!s || !s.ref) return ''
  return `${s.kind || 'dsh'}:${s.ref}${s.label ? `（${s.label}）` : ''}`
}

/** 一行简报：列表 / 匹配结果都用它，控制 token。 */
export function brief(f) {
  const d = daysSince(f.lastTalkAt)
  const gaps = d === null ? '还没说过话' : d === 0 ? '今天说过' : `${d} 天没说话`
  const ch = channelText(f)
  const fits = (f.interests || []).slice(0, 4).join('/')
  return `${f.name}${ch ? `（${ch}）` : ''}｜亲密 ${affinity(f)}｜${gaps}${fits ? `｜爱看 ${fits}` : ''}`
}

/**
 * 一条内容适合给谁：
 * - 主题相关最多 +54（3 个爱好 ×18），最近聊过最多 +16
 * - 亲密度最多 +30（affinity×0.3）
 * - 近 3 天 +8，7 天内 +4，从没聊过 -10
 * - 总分封顶 100，避免「6 个爱好」叠成 218 那种虚高
 */
export function matchScore(f, text, tags) {
  const hay = norm(`${text} ${(tags || []).join(' ')}`)
  const reasons = []
  let score = affinity(f) * 0.3

  let interestHits = 0
  for (const it of f.interests || []) {
    const key = norm(it)
    if (!key || !hay.includes(key)) continue
    if (interestHits < 3) {
      score += 18
      reasons.push(`爱看「${it}」`)
    }
    interestHits += 1
  }

  const recentText = (f.log || []).slice(-8).map((l) => norm(l.text)).join(' ')
  const seen = new Set()
  let recentHits = 0
  for (const it of [...(f.interests || []), ...(tags || [])]) {
    const key = norm(it)
    if (!key || seen.has(key) || !recentText.includes(key)) continue
    seen.add(key)
    if (recentHits < 2) {
      score += 8
      reasons.push(`最近聊过「${it}」`)
    }
    recentHits += 1
  }

  const d = daysSince(f.lastTalkAt)
  if (d === null) {
    score -= 10
    reasons.push('还没聊过，别太突兀')
  } else if (d <= 3) {
    score += 8
    reasons.push('这两天刚说过话')
  } else if (d <= 7) {
    score += 4
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  if (!reasons.length) reasons.push('没什么共同点，只是排到了')
  return { score, reasons: [...new Set(reasons)].slice(0, 3) }
}

/** 按关键词找人：名字 > 别名 > 爱好 > 印象 > 最近聊过。 */
export function searchScore(f, q) {
  const key = norm(q)
  if (!key) return null
  const name = norm(f.name)
  if (name === key) return { score: 100, field: '名字', hit: f.name }
  if (name.startsWith(key)) return { score: 90, field: '名字', hit: f.name }
  if (name.includes(key)) return { score: 80, field: '名字', hit: f.name }
  const alias = (f.aliases || []).find((a) => norm(a).includes(key))
  if (alias) return { score: 70, field: '别名', hit: alias }
  const interest = (f.interests || []).find((i) => norm(i).includes(key))
  if (interest) return { score: 60, field: '爱好', hit: interest }
  if (norm(f.impression).includes(key)) return { score: 40, field: '印象', hit: f.impression }
  const log = (f.log || []).slice(-12).find((l) => norm(l.text).includes(key))
  if (log) return { score: 20, field: '最近聊过', hit: log.text.slice(0, 40) }
  return null
}

/** 内容→人：返回排好序的候选，带匹配分与理由。 */
export function rankByContent(friends, text, tags = [], exclude = []) {
  const skip = new Set(exclude.map((x) => norm(x)))
  return friends
    .filter((f) => !skip.has(norm(f.name)) && !skip.has(norm(f.id)))
    .map((f) => ({ f, ...matchScore(f, text, tags) }))
    .sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name, 'zh'))
}
