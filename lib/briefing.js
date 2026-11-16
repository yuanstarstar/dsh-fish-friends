// 会话交接：新开的专属会话没有上一段记忆，模型进去会「不认识对面是谁」。
// 这里负责在建档 / 绑定 / 换会话之后，先往那个会话投一条「交接记忆」，
// 再投对方的第一条消息；同一条会话只投一次（记在 friend.briefed.sessionRef）。
import { read, mutate } from './store.js'
import { promptSession } from './session.js'
import { affinity, daysSince } from './score.js'

const DAY = 86400000
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function fmtAt(ms) {
  const t = Number(ms) || 0
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function clip(text, n = 90) {
  const t = str(text).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function channelOf(friend, bridgeName) {
  const chs = Array.isArray(friend.channels) ? friend.channels : []
  const byName = bridgeName ? chs.find((c) => str(c.kind) === str(bridgeName) || str(c.platform) === str(bridgeName)) : null
  return byName || chs[0] || null
}

/**
 * 生成「交接记忆」文本。db 用来取消息流里最近的往来；samples 是刚收到、
 * 还没来得及记进 messages 的那几条（自动建档时用）。
 */
export function buildBriefing(friend, db, { bridgeName = '', reason = 'first', samples = [] } = {}) {
  const ch = channelOf(friend, bridgeName)
  const who = str(friend.name) || '这位朋友'
  const aff = affinity(friend)
  const days = daysSince(Number(friend.lastTalkAt) || 0)
  const lines = []
  lines.push(`【鱼友簿 · 会话交接｜系统提示，不是 TA 说的话｜只用来对齐记忆：不要回复这条，也不要为这条调用 friends_send】`)
  lines.push('')
  lines.push(`你现在单独接待一位朋友：${who}。这里不是群聊，也不是主人在跟你说话；读完这条，等下一条消息再回 TA。`)
  lines.push('')
  lines.push('## 对方是谁')
  lines.push(`- 名字：${who}`)
  if (ch) {
    lines.push(`- 通道：桥接「${str(ch.kind) || str(ch.platform)}」，TA 的 id：${str(ch.uid) || '（没记）'}`)
  }
  if (friend.aliases?.length) lines.push(`- 别名：${friend.aliases.join('、')}`)
  lines.push(
    `- 亲密度：${aff}/100${days === null ? '；还没聊过' : `；最近一次聊天：${days === 0 ? '今天' : `${days} 天前`}`}`,
  )
  const talks = (friend.log || []).filter((l) => l && l.kind !== 'share').length
  if (talks) lines.push(`- 已互动：${talks} 次`)
  if (friend.interests?.length) lines.push(`- 爱好：${friend.interests.join('、')}`)
  if (str(friend.impression)) lines.push(`- 印象：${clip(friend.impression, 200)}`)

  // 来历
  lines.push('')
  lines.push('## 你们的来历')
  if (reason === 'first' && friend.autoCreated) {
    const when = fmtAt(Number(friend.createdAt) || Number(friend.lastTalkAt) || Date.now())
    const src = str(friend.sourceBridge) || str(ch?.platform) || ''
    lines.push(`- ${when} 起 TA 在桥接「${src}」连续发来消息，按设置自动建档，并转到这个专属会话接待。`)
    lines.push('- 从这之后，TA 的消息只会进这里；总台会话不会再去接 TA 的消息。')
  } else if (reason === 'rebind') {
    lines.push('- 这是给 TA 换的新会话，之前那个会话里的对话记忆不在这里，所以把要点重新交给你。')
  } else if (reason === 'bind') {
    lines.push(`- ${fmtAt(Date.now())} 我把 TA 绑定到了这个会话，以后 TA 的消息都进这里。`)
  } else {
    lines.push('- 这是第一次在这个会话里接待 TA。')
  }

  // 最近的往来：db.messages 里最近的进出 + 刚收到的 samples（去重）
  const rows = []
  for (const m of (db?.messages || []).filter((m) => m && m.friendId === friend.id).slice(-8)) {
    const dir = m.dir === 'out' ? '我发' : 'TA 说'
    const body = clip(m.text, 80)
    if (body) rows.push(`- ${fmtAt(m.at)} [${dir}] ${body}`)
  }
  for (const s of (Array.isArray(samples) ? samples : []).slice(-3)) {
    const body = clip(s?.text, 80)
    const line = `- ${fmtAt(s?.at)} [TA 说] ${body}`
    if (body && !rows.some((r) => r.endsWith(body))) rows.push(line)
  }
  if (rows.length) {
    lines.push('')
    lines.push('## 最近聊过什么')
    lines.push(...rows.slice(-8))
  } else if (friend.log?.length) {
    const logs = friend.log
      .slice(-6)
      .map((l) => `- ${fmtAt(l.at)} ${l.kind === 'share' ? '[我发的分享]' : '[记下]'} ${clip(l.text, 80)}`)
    lines.push('')
    lines.push('## 以前记过的')
    lines.push(...logs)
  }

  lines.push('')
  lines.push('## 怎么回')
  lines.push(`- 要回话就用工具 friends_send，name 填「${who}」；直接在这里回复不会发到 TA 那儿。`)
  lines.push('- 你认识 TA，别再自我介绍、别问「你是谁」「我们在哪见过」这类话。')
  lines.push('- 语气自然，别一次追问太多；拿不准就顺着 TA 最近说的话接。')

  return lines.join('\n')
}

/**
 * 只组装「交接记忆」文本，不投递。供 deliver 把它和 TA 的第一条消息拼成一次投递，
 * 避免单独一投触发模型对交接说明回一句（甚至误发给 TA）。
 * 返回 {ok, skipped, reason, text, sessionId}
 */
export async function prepareBriefing(friendId, { bridgeName = '', reason = 'first', samples = [], force = false } = {}) {
  const snap = await read((db) => {
    const f = (db.friends || []).find((x) => x && x.id === friendId) || null
    if (!f) return { missing: true }
    const ref = str(f.session?.ref)
    if (!ref) return { noSession: true }
    if (str(f.session?.kind) === 'url') return { urlSession: true }
    if (!force && f.briefed && str(f.briefed.sessionRef) === ref) return { already: true }
    return {
      friend: JSON.parse(JSON.stringify(f)),
      ref,
      db: { messages: (db.messages || []).slice(-60) },
      // 之前交接记录指向别的会话 = 换绑/重建，用「换的新会话」措辞
      reason: f.briefed && str(f.briefed.sessionRef) && str(f.briefed.sessionRef) !== ref ? 'rebind' : reason,
    }
  })
  if (snap.missing) return { ok: false, skipped: true, reason: 'no-friend' }
  if (snap.noSession) return { ok: false, skipped: true, reason: 'no-session' }
  if (snap.urlSession) return { ok: false, skipped: true, reason: 'url-session' }
  if (snap.already) return { ok: true, skipped: true, reason: 'already-briefed', sessionId: snap.ref }

  const text = buildBriefing(snap.friend, snap.db, {
    bridgeName: bridgeName || str(snap.friend.sourceBridge),
    reason: snap.reason,
    samples,
  })
  return { ok: true, skipped: false, reason: snap.reason, text, sessionId: snap.ref, chars: text.length, friendName: snap.friend.name }
}

/** 记下「这个会话已经交接过了」，同一个会话不再重复投。 */
export async function markBriefed(friendId, sessionRef) {
  const ref = str(sessionRef)
  if (!friendId || !ref) return false
  await mutate((db) => {
    const f = (db.friends || []).find((x) => x && x.id === friendId)
    if (!f) return { noSave: true }
    f.briefed = { sessionRef: ref, at: Date.now() }
    return undefined
  })
  return true
}

/**
 * 需要时单独投一条交接记忆（换绑、激活、手动重发用）。
 * 返回 {ok, skipped, reason, sessionId, error}
 */
export async function briefIfNeeded(ctx, friendId, opts = {}) {
  const prep = await prepareBriefing(friendId, opts)
  if (prep.skipped) return prep
  if (!prep.ok) return prep
  const sent = await promptSession(ctx, prep.sessionId, prep.text)
  if (!sent.ok) return { ok: false, skipped: false, reason: 'prompt-failed', sessionId: prep.sessionId, error: sent.error }
  await markBriefed(friendId, prep.sessionId)
  return { ok: true, skipped: false, sessionId: prep.sessionId, chars: prep.chars }
}

/** 强制重发一次（面板/工具里的「重新交接」用）。 */
export async function resendBriefing(ctx, friendId, opts = {}) {
  return briefIfNeeded(ctx, friendId, { ...opts, force: true })
}

export const _internal = { buildBriefing, channelOf, clip }

export { DAY }
