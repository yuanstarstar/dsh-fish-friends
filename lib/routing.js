// 路由层：外来消息 → 谁收、进哪个会话、要不要限流。
//
// 规则（按用户要求）：
//   1. 同一个人的消息先都进「总台会话」（settings.routing.sharedSession）。
//   2. 同一个人（同桥接 + 同 uid）累计收到 promoteAfter 次（默认 3）→ 自动建档，
//      并给他在专属工作区建一个专属会话；从这一刻起这个人只进专属会话。
//   3. 专属会话可以限流（friend.limits 覆盖 settings.rate）：窗口内超了就先压着，
//      等窗口滑过去再投（hold 队列），不会丢消息。
import fs from 'node:fs'
import { read, mutate, newId, norm, workspaceFor } from './store.js'
import { createSession, promptSession, queueActivation } from './session.js'
import { briefIfNeeded, markBriefed, prepareBriefing } from './briefing.js'

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

/** 所有启用中的总台会话。 */
export function sharedList(db) {
  const list = Array.isArray(db?.settings?.routing?.sharedSessions) ? db.settings.routing.sharedSessions : []
  return list.filter((s) => s && str(s.ref).trim() && s.enabled !== false)
}

/** 多个总台轮流接：挑最久没接过的那个（lastAt 最小）。 */
export function pickShared(db) {
  const list = sharedList(db)
  if (!list.length) return null
  return list
    .slice()
    .sort((a, b) => (Number(a.lastAt) || 0) - (Number(b.lastAt) || 0) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))[0]
}

export function findBridge(db, key) {
  const k = norm(key)
  if (!k) return null
  return (db.bridges || []).find((b) => norm(b.id) === k || norm(b.name) === k) || null
}

/** 按「桥接 + 对方 uid」找人：渠道数组里 platform=桥接 id、uid=对方 id。 */
export function findFriendBySender(db, bridgeId, uid) {
  const b = str(bridgeId).trim()
  const u = str(uid).trim()
  if (!b || !u) return null
  return (
    (db.friends || []).find((f) => (f.channels || []).some((c) => str(c.platform).trim() === b && str(c.uid).trim() === u)) ||
    null
  )
}

/** 专属会话的有效限流参数：朋友覆盖 → 全局默认。 */
export function effectiveRate(db, friend) {
  const g = db?.settings?.rate || { windowMs: 3600000, max: 30 }
  const l = friend?.limits || {}
  return {
    windowMs: Number(l.windowMs) > 0 ? Number(l.windowMs) : g.windowMs,
    max: Number(l.max) > 0 ? Number(l.max) : g.max,
  }
}

/** 窗口内这个朋友进来了多少条（只算投进专属会话的）。 */
export function inboundCount(db, friendId, windowMs, at = Date.now()) {
  const from = at - windowMs
  return (db.messages || []).filter(
    (m) => m.dir === 'in' && m.friendId === friendId && m.route === 'dedicated' && Number(m.at) >= from,
  ).length
}

function recordMessage(db, row) {
  db.messages = Array.isArray(db.messages) ? db.messages : []
  db.messages.push(row)
  if (db.messages.length > 300) db.messages = db.messages.slice(-300)
  return row
}

function touchBridge(db, bridgeId, at, ok = true) {
  const b = findBridge(db, bridgeId)
  if (!b) return
  b.lastInAt = at
  b.stats = b.stats || { in: 0, out: 0, errors: 0 }
  if (ok) b.stats.in = (Number(b.stats.in) || 0) + 1
  else b.stats.errors = (Number(b.stats.errors) || 0) + 1
}

function displayNameOf(msg) {
  const n = str(msg.name).trim()
  if (n) return n
  return `朋友-${str(msg.uid).slice(0, 8)}`
}

/** 确保这个朋友有专属会话（没有就按「专属工作区」建一个并绑定）。 */
export async function ensureSession(ctx, friend) {
  if (!friend || !friend.id) return { ok: false, error: '没有这个人' }
  if (friend.session?.ref) return { ok: true, sessionId: friend.session.ref, created: false }
  const dir = workspaceFor(friend)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录建不出来就退回默认 cwd */
  }
  const made = await createSession(ctx, { cwd: dir })
  if (!made.ok) return { ok: false, error: made.error }
  const session = { kind: 'dsh', ref: made.sessionId, label: friend.name }
  await mutate((db) => {
    const f = (db.friends || []).find((x) => x && x.id === friend.id)
    if (f && !f.session?.ref) f.session = session
    return undefined
  })
  friend.session = session
  return { ok: true, sessionId: made.sessionId, created: true }
}

/**
 * 公共场合聊起来以后：给 TA 开私聊会话，并让机器人在专属会话里接着聊。
 * 不是自己发消息给 TA —— 是投一条指令，让专属会话里的机器人用 friends_send 开口开场。
 */
export async function inviteToPrivate(ctx, { friend, bridgeId = '', bridgeName = '', at = Date.now(), lastText = '', reason = 'public' } = {}) {
  if (!friend || !friend.id) return { ok: false, error: '没有这个人' }
  const ensured = await ensureSession(ctx, friend)
  if (!ensured.ok) return { ok: false, error: ensured.error }
  const cfg = await read((db) => db.settings?.routing?.publicToPrivate || {})
  const opener = str(cfg.opener).trim()
  const head =
    reason === 'manual'
      ? `你想把和「${friend.name}」的聊天转到私聊`
      : `你和「${friend.name}」刚在公共频道聊起来`
  const instruction = [
    `【鱼友簿 · 私聊邀请｜系统提示】${head}。`,
    lastText ? `刚才聊到：「${str(lastText).slice(0, 100)}」。` : '',
    opener ? `开场可以这样接：${opener}` : '请用一句话自然地把话题接下去。',
    `请调用 friends_send（name="${friend.name}"）发一句简短的私聊开场；别复述这条提示，也别继续在总台里发。`,
  ]
    .filter(Boolean)
    .join('\n')
  const sent = await promptSession(ctx, ensured.sessionId, instruction)
  if (!sent.ok) return { ok: false, error: sent.error, sessionId: ensured.sessionId }
  await mutate((db) => {
    const f = (db.friends || []).find((x) => x && x.id === friend.id)
    if (f) {
      f.lastPrivateInviteAt = at
      f.lastTalkAt = Math.max(Number(f.lastTalkAt) || 0, at)
      f.updatedAt = at
    }
    recordMessage(db, {
      id: newId(),
      at,
      dir: 'out',
      bridgeId: bridgeId || str(friend.channels?.[0]?.platform),
      friendId: friend.id,
      name: friend.name,
      text: '（自动：公共场合转私聊，已在专属会话接话）',
      route: 'invited',
      note: bridgeName ? `来自 ${bridgeName}` : '',
    })
    queueActivation(db, f || friend, { sessionId: ensured.sessionId, note: '公共场合转私聊' })
    return undefined
  })
  return { ok: true, sessionId: ensured.sessionId, created: ensured.created }
}

/**
 * 投一条消息到会话。返回 {route, reason, sessionId}
 * route: dedicated | shared | held | dropped | pending
 */
async function deliver(ctx, { friend, bridgeId, bridgeName, uid, senderName, text, at, intro }) {
  // 先读快照决定去哪儿，再异步投递，最后一次性落盘
  const snap = await read((db) => {
    const fresh = friend ? (db.friends || []).find((f) => f.id === friend.id) || friend : null
    const shared = fresh?.session?.ref ? null : pickShared(db)
    const target = fresh?.session?.ref
      ? { ref: fresh.session.ref, route: 'dedicated' }
      : shared
        ? { ref: shared.ref, route: 'shared', sharedId: shared.id }
        : null
    const rate = fresh ? effectiveRate(db, fresh) : null
    const used = fresh && target && target.route === 'dedicated' ? inboundCount(db, fresh.id, rate.windowMs, at) : 0
    const p2p = db.settings?.routing?.publicToPrivate || {}
    const cooldown = Math.max(60000, Number(p2p.cooldownMs) || 86400000)
    const seen = fresh
      ? (db.messages || []).filter((m) => m.dir === 'in' && m.friendId === fresh.id && Number(m.at) >= at - 86400000).length
      : 0
    const inviteReady = !!(
      fresh &&
      p2p.enabled === true &&
      seen >= Math.max(1, Number(p2p.afterMessages) || 1) &&
      at - (Number(fresh.lastPrivateInviteAt) || 0) >= cooldown
    )
    return { friend: fresh, target, rate, used, inviteReady }
  })

  const { friend: fresh, target, rate, used, inviteReady } = snap
  const who = senderName || displayNameOf({ uid, name: senderName })
  let route = 'dropped'
  let note = ''
  let sessionId = ''
  let heldId = ''
  let invite = null

  if (!target) {
    route = 'pending'
    note = '既没有总台会话，这个人也还没绑定专属会话 —— 消息只记下来了'
  } else if (target.route === 'dedicated' && fresh && used >= rate.max) {
    route = 'held'
    note = `专属会话 ${rate.windowMs / 60000} 分钟内已收 ${used} 条（上限 ${rate.max}），先压着`
  } else {
    sessionId = target.ref
    // 新会话（或换了会话）先补交接记忆：和 TA 的第一条消息拼成一次投递，
    // 避免单独投递触发模型对交接说明回一句、甚至误发给 TA。
    let briefWarn = ''
    let briefHead = ''
    if (target.route === 'dedicated' && fresh) {
      const prep = await prepareBriefing(fresh.id, {
        bridgeName: bridgeName || bridgeId,
        reason: intro?.reason || 'first',
        samples: intro?.samples || [],
      })
      if (prep.ok && prep.text) {
        briefHead = `${prep.text}\n\n—— 下面这条才是 TA 刚发来的消息 ——\n`
      } else if (!prep.skipped) {
        briefWarn = `；交接记忆没送到（${prep.error || prep.reason}）`
      }
    }
    const plain = `【${bridgeName || bridgeId}/${who}】${text}`
    const body = `${briefHead}${plain}`
    let sent = await promptSession(ctx, sessionId, body)
    if (!sent.ok && briefHead) {
      // 交接记忆把消息带崩了：退一步只投消息，消息不能因为交接而丢
      briefWarn = `；交接记忆没送到（${sent.error || '未知错误'}）`
      briefHead = ''
      sent = await promptSession(ctx, sessionId, plain)
    }
    if (sent.ok) {
      route = target.route
      if (briefHead) await markBriefed(fresh.id, sessionId)
      if (briefWarn) note = `已投递${briefWarn}`
      // 在总台（公共场合）和一个已经认识的人聊起来了：自动给 TA 开私聊，并在专属会话里接着开口
      if (route === 'shared' && fresh && inviteReady) {
        invite = await inviteToPrivate(ctx, { friend: fresh, bridgeId, bridgeName, at, lastText: text })
        note = `${note ? `${note}；` : ''}${
          invite.ok
            ? `公共场合聊起来了，已自动开私聊并在专属会话接话（${invite.sessionId}）`
            : `想转私聊但没成功（${invite.error}）`
        }`
      }
    } else {
      route = 'dropped'
      note = `投递失败：${sent.error}${briefWarn}`
    }
  }

  await mutate((db) => {
    const row = {
      id: newId(),
      at,
      dir: 'in',
      bridgeId,
      friendId: fresh?.id || '',
      name: who,
      text,
      route,
      note,
    }
    recordMessage(db, row)
    if (route === 'held') {
      db.holds = Array.isArray(db.holds) ? db.holds : []
      heldId = newId()
      db.holds.push({
        id: heldId,
        friendId: fresh?.id || '',
        friendName: fresh?.name || who,
        bridgeId,
        uid,
        text,
        at,
        reason: 'rate-limit',
      })
      if (db.holds.length > 200) db.holds = db.holds.slice(-200)
    }
    const f = fresh ? (db.friends || []).find((x) => x.id === fresh.id) : null
    if (f && route !== 'dropped' && route !== 'pending') {
      f.lastTalkAt = Math.max(Number(f.lastTalkAt) || 0, at)
      f.updatedAt = Date.now()
    }
    touchBridge(db, bridgeId, at, route !== 'dropped')
    // 多个总台轮流接：记下这个总台刚接过消息，下次优先挑别的
    if (route === 'shared' && target?.sharedId) {
      const s = (db.settings?.routing?.sharedSessions || []).find((x) => x && x.id === target.sharedId)
      if (s) s.lastAt = at
    }
    return { value: { route, note, sessionId, heldId, friendId: f?.id || fresh?.id || '', invited: !!invite?.ok } }
  })
  return { route, note, sessionId, heldId, friendId: fresh?.id || '', invited: !!invite?.ok, inviteSessionId: invite?.sessionId || '' }
}

/** 自动建档：建好友记录 + 在专属工作区建会话并绑定。
 *  并发安全：先用一次 mutate 原子地「查重 + 占位建档」，再建会话，避免同一个人被建两份档案。 */
export async function promote(ctx, { bridgeId, bridgeName, uid, name, at = Date.now() }) {
  const reserve = await mutate((db) => {
    const existing = findFriendBySender(db, bridgeId, uid)
    if (existing) {
      // 别人已经建过档（并发/重复判定）：直接复用，不新建
      db.pendingSenders = (db.pendingSenders || []).filter((p) => p.key !== `${bridgeId}:${uid}`)
      return { value: { friend: existing, existed: true, isNew: false } }
    }
    const friend = {
      id: newId(),
      name: displayNameOf({ uid, name }),
      aliases: [],
      interests: [],
      impression: '',
      channels: [{ platform: bridgeId, uid, kind: bridgeName || '桥接' }],
      log: [],
      autoCreated: true,
      sourceBridge: bridgeId,
      createdAt: at,
      updatedAt: at,
      lastTalkAt: at,
      session: null,
    }
    db.friends = Array.isArray(db.friends) ? db.friends : []
    db.friends.push(friend)
    db.pendingSenders = (db.pendingSenders || []).filter((p) => p.key !== `${bridgeId}:${uid}`)
    const b = findBridge(db, bridgeId)
    if (b) {
      b.stats = b.stats || { in: 0, out: 0, errors: 0 }
      b.stats.promoted = (Number(b.stats.promoted) || 0) + 1
    }
    return { value: { friend, existed: false, isNew: true } }
  })
  const friend = reserve.friend
  if (!friend) {
    await mutate((db) => {
      const p = (db.pendingSenders || []).find((x) => x.key === `${bridgeId}:${uid}`)
      if (p) delete p.promoting
      return undefined
    })
    return { friend: null, sessionError: '建档失败' }
  }
  if (!reserve.isNew) return { friend, sessionError: '', existed: true }

  let sessionError = ''
  const dir = workspaceFor(friend)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录建不出来就退回默认 cwd */
  }
  const made = await createSession(ctx, { cwd: dir })
  if (made.ok) {
    friend.session = { kind: 'dsh', ref: made.sessionId, label: friend.name }
    await mutate((db) => {
      const f = (db.friends || []).find((x) => x && x.id === friend.id)
      if (!f) return { noSave: true }
      if (!f.session?.ref) f.session = { kind: 'dsh', ref: made.sessionId, label: f.name }
      return undefined
    })
  } else {
    sessionError = made.error
  }
  return { friend, sessionError, existed: false }
}

/**
 * 收一条外来消息（桥接运行时 / 工具 / HTTP 都走这里）。
 * 同一个发送者（bridgeId:uid）的入站串行处理，避免两条消息同时跨过建档阈值、建出两份档案。
 * 返回 {route, friendId, friendName, promoted, note}
 */
const ingestChains = new Map()
export function ingestIncoming(ctx, input = {}) {
  const bridgeId = str(input.bridgeId).trim()
  const uid = str(input.uid).trim()
  const key = `${bridgeId}:${uid}`
  const prev = ingestChains.get(key) || Promise.resolve()
  const run = prev.catch(() => {}).then(() => ingestOnce(ctx, input))
  ingestChains.set(key, run)
  return run.finally(() => {
    if (ingestChains.get(key) === run) ingestChains.delete(key)
  })
}

async function ingestOnce(ctx, input = {}) {
  const bridgeId = str(input.bridgeId).trim()
  const uid = str(input.uid).trim()
  const text = str(input.text).trim()
  const at = Number(input.at) || Date.now()
  if (!bridgeId) return { ok: false, error: '缺 bridgeId（消息从哪个桥来）' }
  if (!uid) return { ok: false, error: '缺 uid（对方是谁）' }
  if (!text) return { ok: false, error: '消息是空的' }

  // 第一步：判断是熟人、陌生人、还是该建档了（这一步会写 pendingSenders）
  const step = await mutate((db) => {
    const bridge = findBridge(db, bridgeId)
    const bridgeName = bridge?.name || str(input.bridgeName) || bridgeId
    const friend = findFriendBySender(db, bridgeId, uid)
    if (friend) return { value: { kind: 'existing', friend, bridgeName } }
    const threshold = Math.max(1, Number(db.settings?.routing?.promoteAfter) || 3)
    const key = `${bridgeId}:${uid}`
    db.pendingSenders = Array.isArray(db.pendingSenders) ? db.pendingSenders : []
    let p = db.pendingSenders.find((x) => x.key === key)
    if (!p) {
      p = { key, bridgeId, uid, name: str(input.name), count: 0, firstAt: at, lastAt: at, samples: [] }
      db.pendingSenders.push(p)
    }
    p.count = (Number(p.count) || 0) + 1
    p.lastAt = at
    if (str(input.name)) p.name = str(input.name)
    p.samples = Array.isArray(p.samples) ? p.samples : []
    p.samples.push({ at, text: text.slice(0, 200) })
    if (p.samples.length > 3) p.samples = p.samples.slice(-3)
    if (db.pendingSenders.length > 100) db.pendingSenders = db.pendingSenders.slice(-100)
    if (p.count >= threshold) {
      // 已有一次建档在飞：这条先暂存，等档案建好再补投到专属会话，别触发第二次建档
      if (p.promoting && at - Number(p.promoting) < 60000) {
        return { value: { kind: 'promoting', pending: { ...p }, bridgeName, threshold } }
      }
      p.promoting = at
      return { value: { kind: 'promote', pending: { ...p }, bridgeName, threshold } }
    }
    return { value: { kind: 'pending', pending: { ...p }, bridgeName, threshold } }
  })

  if (step.kind === 'existing') {
    const r = await deliver(ctx, {
      friend: step.friend,
      bridgeId,
      bridgeName: step.bridgeName,
      uid,
      senderName: step.friend.name,
      text,
      at,
    })
    return { ok: true, route: r.route, friendId: step.friend.id, friendName: step.friend.name, promoted: false, note: r.note }
  }

  if (step.kind === 'pending') {
    const r = await deliver(ctx, {
      friend: null,
      bridgeId,
      bridgeName: step.bridgeName,
      uid,
      senderName: str(input.name) || step.pending.name,
      text,
      at,
    })
    return {
      ok: true,
      route: r.route,
      friendId: '',
      friendName: '',
      promoted: false,
      note:
        r.note ||
        `陌生人计数 ${step.pending.count}/${step.threshold}：还差 ${step.threshold - step.pending.count} 条就会自动建档、建专属会话`,
    }
  }

  if (step.kind === 'promoting') {
    // 建档正在进行中：这条先压着，等 promote 完成后由 releaseHolds 补投到专属会话
    await mutate((db) => {
      db.holds = Array.isArray(db.holds) ? db.holds : []
      db.holds.push({
        id: newId(),
        friendId: '',
        friendName: str(input.name) || step.pending.name,
        bridgeId,
        uid,
        text,
        at,
        reason: 'promoting',
      })
      if (db.holds.length > 200) db.holds = db.holds.slice(-200)
      recordMessage(db, {
        id: newId(),
        at,
        dir: 'in',
        bridgeId,
        friendId: '',
        name: str(input.name) || step.pending.name,
        text,
        route: 'held',
        note: '正在建档，暂存等补投',
      })
      return undefined
    })
    return {
      ok: true,
      route: 'held',
      friendId: '',
      friendName: str(input.name) || step.pending.name,
      promoted: false,
      note: `正在给「${str(input.name) || step.pending.name}」建档，这条先暂存，档案建好后自动补投到专属会话`,
    }
  }

  // 第三步：够了 → 建档 + 建专属会话 + 投到专属会话
  const made = await promote(ctx, { bridgeId, bridgeName: step.bridgeName, uid, name: str(input.name) || step.pending.name, at })
  const r = await deliver(ctx, {
    friend: made.friend,
    bridgeId,
    bridgeName: step.bridgeName,
    uid,
    senderName: made.friend.name,
    text,
    at,
    intro: { reason: 'first', samples: step.pending.samples || [] },
  })
  return {
    ok: true,
    route: r.route,
    friendId: made.friend.id,
    friendName: made.friend.name,
    promoted: true,
    sessionId: made.friend.session?.ref || '',
    note: made.sessionError
      ? `已自动建档，但建专属会话失败（${made.sessionError}）；消息先走了总台或其他会话`
      : `收到第 ${step.threshold} 条，已自动建档「${made.friend.name}」并建了专属会话`,
  }
}

/** 出站：通过桥发给某个朋友，并记消息流。 */
export async function sendToFriend(ctx, db, friend, text, { bridgeId, kind = 'reply' } = {}) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '消息是空的' }
  const channels = Array.isArray(friend?.channels) ? friend.channels : []
  const ch =
    channels.find((c) => c.platform === bridgeId && str(c.uid).trim()) ||
    channels.find((c) => str(c.uid).trim()) ||
    null
  if (!ch) return { ok: false, error: `${friend?.name || '这个人'} 没有可用的联系通道（先 friends_upsert 补 channels）` }
  const bridge = findBridge(db, ch.platform) || findBridge(db, bridgeId)
  if (!bridge) return { ok: false, error: `没有找到桥接 ${ch.platform}（先 friends_bridge 建一个）` }
  const { sendViaBridge } = await import('./bridge.js')
  const sent = await sendViaBridge({ bridge, to: ch.uid, name: friend.name, text: body, kind })
  await mutate((d) => {
    recordMessage(d, {
      id: newId(),
      at: Date.now(),
      dir: 'out',
      bridgeId: bridge.id,
      friendId: friend.id,
      name: friend.name,
      text: body,
      route: 'out',
      note: sent.ok ? '' : String(sent.error || ''),
    })
    const f = (d.friends || []).find((x) => x.id === friend.id)
    if (f) {
      f.lastTalkAt = Date.now()
      f.updatedAt = Date.now()
      f.log = Array.isArray(f.log) ? f.log : []
      f.log.push({ at: Date.now(), kind: kind === 'proactive' ? 'talk' : 'talk', text: body.slice(0, 500) })
      if (f.log.length > 80) f.log = f.log.slice(-80)
    }
    const b = findBridge(d, bridge.id)
    if (b) {
      b.lastOutAt = Date.now()
      b.stats = b.stats || { in: 0, out: 0, errors: 0 }
      if (sent.ok) b.stats.out = (Number(b.stats.out) || 0) + 1
      else b.stats.errors = (Number(b.stats.errors) || 0) + 1
    }
    return undefined
  })
  return { ok: sent.ok === true, error: sent.error, bridgeId: bridge.id, to: ch.uid }
}

/** 窗口滑过去后，把压着的消息放出来投递。 */
export async function releaseHolds(ctx) {
  const snap = await read((db) => {
    const holds = Array.isArray(db.holds) ? db.holds.slice() : []
    return holds
  })
  if (!snap.length) return { released: 0, kept: 0 }
  let released = 0
  let kept = 0
  for (const h of snap) {
    const info = await read((db) => {
      let f = (db.friends || []).find((x) => x.id === h.friendId)
      // 建档途中压下的消息还没有 friendId：按通道+uid 找回这个人
      if (!f && h.uid) f = findFriendBySender(db, h.bridgeId, h.uid)
      if (!f) return { drop: true }
      const rate = effectiveRate(db, f)
      const used = inboundCount(db, f.id, rate.windowMs, Date.now())
      return { drop: false, f, rate, used, target: f.session?.ref || '' }
    })
    if (info.drop) {
      await mutate((db) => {
        db.holds = (db.holds || []).filter((x) => x.id !== h.id)
        return undefined
      })
      continue
    }
    if (!info.target) {
      // 专属会话还在建（刚建档）或没建成：留着下次再试，别丢
      kept += 1
      continue
    }
    if (info.used >= info.rate.max) {
      kept += 1
      continue
    }
    // 会话可能是新建/换过的：先补一条交接记忆，再投压着的消息
    const bridged = await briefIfNeeded(ctx, info.f.id, { bridgeName: h.bridgeId, reason: 'first' })
    const briefWarn = bridged && bridged.ok === false && !bridged.skipped ? `；交接记忆没送到（${bridged.error}）` : ''
    const sent = await promptSession(ctx, info.target, `【${h.bridgeId}｜${h.friendName}】${h.text}`)
    await mutate((db) => {
      db.holds = (db.holds || []).filter((x) => x.id !== h.id)
      recordMessage(db, {
        id: newId(),
        at: Date.now(),
        dir: 'in',
        bridgeId: h.bridgeId,
        friendId: h.friendId,
        name: h.friendName,
        text: h.text,
        route: sent.ok ? 'dedicated' : 'dropped',
        note: sent.ok ? `限流窗口已过，补投${briefWarn}` : `补投失败：${sent.error}`,
      })
      return undefined
    })
    if (sent.ok) released += 1
  }
  return { released, kept }
}

export const _internal = { deliver, promote }
