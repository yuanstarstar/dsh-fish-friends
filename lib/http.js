// 面板用的 HTTP 接口：挂在 DSH 自己的 webServer 上（prefix = PREFIX）。
// 只服务本机 GUI，同源请求；不联网、不鉴权（与 dsh-meituan 相同做法）。
import { read, mutate, resolve, norm, newId, newSharedSession, bridgeDir, workspaceRoot } from './store.js'
import { affinity, brief, rankByContent, searchScore, channelText, daysSince, DAY } from './score.js'
import { describeSession, pendingActivations, ackActivations, promptSession, queueActivation, sessionBinding, signalOf } from './session.js'
import { briefIfNeeded } from './briefing.js'
import { BRIDGE_KINDS, newBridgeId, runtime as bridgeRuntime } from './bridge.js'
import { effectiveRate, findBridge, findFriendBySender, inboundCount, ingestIncoming, inviteToPrivate, promote, sendToFriend, sharedList } from './routing.js'
import { nextDuePreview, proactiveConfig, proactiveSentToday, tickProactive } from './proactive.js'
import { analyzeRhythm, rhythmLine } from './rhythm.js'
import { goalStatus, goalLine, tickGoal } from './goal.js'
import fs from 'node:fs'
import path from 'node:path'

export const PREFIX = '/dsh-fish-friends/api'
const MAX_BODY = 256 * 1024

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function metaOf(meta) {
  if (!meta) return { status: 'ok', warnings: [] }
  return {
    status: meta.status,
    error: meta.error || '',
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    corruptCopy: meta.corruptCopy,
  }
}

function friendCard(f, session, db) {
  const d = daysSince(f.lastTalkAt)
  const rhythm = db ? analyzeRhythm(db, f) : null
  const log = (f.log || []).slice(-3).map((l) => ({
    at: l.at,
    kind: l.kind,
    text: l.text,
    sent: l.kind === 'share' ? l.sent === true : undefined,
    mood: l.mood,
  }))
  return {
    id: f.id,
    name: f.name,
    needsName: f._needsName === true,
    aliases: f.aliases || [],
    interests: f.interests || [],
    impression: f.impression || '',
    channels: (f.channels || []).map((c) => `${c.platform} ${c.kind}${c.uid ? ` ${c.uid}` : ''}`),
    channelText: channelText(f),
    affinity: affinity(f),
    talks: (f.log || []).filter((l) => l.kind !== 'share').length,
    shareSent: (f.log || []).filter((l) => l.kind === 'share' && l.sent === true).length,
    sharePending: (f.log || []).filter((l) => l.kind === 'share' && l.sent !== true).length,
    daysSince: d,
    lastTalkAt: f.lastTalkAt || 0,
    lastPrivateInviteAt: f.lastPrivateInviteAt || 0,
    log,
    session: session || { bound: false },
    autoCreated: f.autoCreated === true,
    sourceBridge: f.sourceBridge || '',
    limits: f.limits || null,
    proactiveEnabled: f.proactive?.enabled === true,
    rhythm: rhythm && rhythm.ok ? { total: rhythm.total, activeHours: rhythm.activeHours, text: rhythm.text, line: rhythmLine(rhythm), peakHour: rhythm.peakHour } : null,
  }
}

/** GET /graph：面板整页数据（一次拿全，别让面板自己拼多个请求）。 */
async function graph(ctx, url) {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit')) || 200)))
  const snapshot = await read((db, meta) => ({
    db: JSON.parse(JSON.stringify(db)),
    meta,
  }))
  const db = snapshot.db
  const friends = db.friends.slice(0, limit)
  const cards = []
  for (const f of friends) {
    let session = null
    if (f.session?.ref) {
      session = await describeSession(ctx, f)
      // 只给面板需要的字段，不把 ctx 里的东西泄漏出去
      session = {
        bound: true,
        kind: session.kind,
        ref: session.ref,
        label: session.label,
        exists: session.exists,
        external: session.external === true,
        title: session.title,
        running: session.running === true,
        blank: session.blank === true,
        updatedAt: session.updatedAt || 0,
        lookupError: session.lookupError,
      }
    }
    cards.push(friendCard(f, session || { bound: false }, db))
  }
  cards.sort((a, b) => b.affinity - a.affinity || String(a.name).localeCompare(String(b.name), 'zh'))
  const host = await describeHost(ctx)
  const bridges = (db.bridges || []).map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    enabled: b.enabled !== false,
    stats: { in: Number(b.stats?.in) || 0, out: Number(b.stats?.out) || 0, errors: Number(b.stats?.errors) || 0, promoted: Number(b.stats?.promoted) || 0 },
    dir: b.kind === 'file' ? bridgeDir(b.id) : '',
    sendUrl: b.kind === 'http' ? String(b.config?.sendUrl || '') : '',
  }))
  const now = Date.now()
  const shared = sharedList(db).map((s) => ({
    id: s.id,
    kind: s.kind,
    ref: s.ref,
    label: s.label || '',
    enabled: s.enabled !== false,
    goal: s.goal !== false,
    lastAt: Number(s.lastAt) || 0,
  }))
  const st = goalStatus(db, now)
  return {
    ok: true,
    data: {
      generatedAt: now,
      total: db.friends.length,
      shown: cards.length,
      friends: cards,
      settings: db.settings,
      meta: metaOf(snapshot.meta),
      host,
      pending: pendingActivations(db).length,
      bridges,
      bridgeRuntime: { running: bridgeRuntime.running === true, startedAt: bridgeRuntime.startedAt || 0, errors: (bridgeRuntime.errors || []).slice(-5) },
      messages: (db.messages || []).slice(-60).reverse(),
      pendingSenders: (db.pendingSenders || []).map((p) => ({ name: p.name || p.uid, uid: p.uid, bridgeId: p.bridgeId, count: p.count, threshold: db.settings?.routing?.promoteAfter || 3, lastAt: p.lastAt })),
      holds: (db.holds || []).length,
      routing: db.settings?.routing || {},
      sharedSessions: shared,
      sharedSession: shared[0] || null,
      publicToPrivate: db.settings?.routing?.publicToPrivate || {},
      rate: db.settings?.rate || {},
      proactive: {
        config: db.settings?.proactive || {},
        preview: nextDuePreview(db, now, 6),
        sentToday: (db.friends || []).reduce((n, f) => n + proactiveSentToday(db, f.id, now), 0),
      },
      goal: { status: st, line: goalLine(st) },
      workspaceRoot: workspaceRoot(),
    },
  }
}

async function describeHost(ctx) {
  const svc = ctx?.sessionController
  if (!svc || typeof svc.list !== 'function') {
    return { sessions: false, reason: '宿主没有 sessionController，会话功能不可用' }
  }
  return { sessions: true, prompt: typeof svc.prompt === 'function', create: typeof svc.create === 'function' }
}

/** POST /for：内容→发给谁，只读命中的人，不把整表塞给模型。 */
async function forContent(url) {
  const text = String(url.searchParams.get('text') || '').trim()
  const tags = String(url.searchParams.get('tags') || '')
    .split(/[,，\s]+/)
    .filter(Boolean)
  const limit = Math.max(1, Math.min(10, Math.floor(Number(url.searchParams.get('limit')) || 1)))
  if (!text) return { ok: false, error: '缺少 text' }
  return read((db, meta) => {
    if (!db.friends.length) return { ok: false, error: '鱼友簿还是空的', meta: metaOf(meta) }
    const ranked = rankByContent(db.friends, text, tags)
    const top = ranked.slice(0, limit).map((r) => ({
      id: r.f.id,
      name: r.f.name,
      score: r.score,
      reasons: r.reasons,
      channelText: channelText(r.f),
      session: r.f.session?.ref ? sessionBinding(r.f) : { bound: false },
      affinity: affinity(r.f),
    }))
    const rest = ranked.slice(limit, limit + 3).map((r) => ({ id: r.f.id, name: r.f.name, score: r.score }))
    return { ok: true, data: { picks: top, alternatives: rest, meta: metaOf(meta) } }
  })
}

/** GET /search：关键词找人。 */
async function search(url) {
  const q = String(url.searchParams.get('q') || '').trim()
  const limit = Math.max(1, Math.min(20, Math.floor(Number(url.searchParams.get('limit')) || 5)))
  if (!q) return { ok: false, error: '缺少 q' }
  return read((db, meta) => {
    const hits = db.friends
      .map((f) => ({ f, hit: searchScore(f, q) }))
      .filter((x) => x.hit)
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, limit)
      .map((x) => ({ id: x.f.id, name: x.f.name, score: x.hit.score, field: x.hit.field, hit: x.hit.hit, affinity: affinity(x.f) }))
    return { ok: true, data: { hits, total: db.friends.length, meta: metaOf(meta) } }
  })
}

async function sessionRoute(ctx, body) {
  const action = String(body.action || 'bind')
  const name = String(body.name || '').trim()
  if (!name) return { ok: false, error: '缺少 name' }
  if (action === 'list') {
    const listed = await listAllSessions(ctx)
    return { ok: true, data: listed }
  }
  const saved = await mutate((db, meta) => {
    const r = resolve(db, name)
    if (!r.friend) return { noSave: true, value: { ok: false, error: `没有「${name}」这个鱼友` } }
    const f = r.friend
    if (action === 'clear') {
      f.session = undefined
      f.updatedAt = Date.now()
      return { value: { ok: true, data: { name: f.name, cleared: true }, meta: metaOf(meta) } }
    }
    const ref = String(body.ref || '').trim()
    if (!ref) return { noSave: true, value: { ok: false, error: '缺少 ref（会话 id 或地址）' } }
    f.session = {
      kind: String(body.kind || 'dsh'),
      ref,
      label: String(body.label || ''),
    }
    f.updatedAt = Date.now()
    return { value: { ok: true, data: { name: f.name, session: f.session }, meta: metaOf(meta), friendId: f.id, bridge: (f.channels || [])[0]?.kind || '' } }
  })
  if (saved.ok && saved.data?.session) {
    const desc = await describeSession(ctx, { name, session: saved.data.session })
    saved.data.session = { ...saved.data.session, ...desc }
    if (saved.friendId && saved.data.session.kind === 'dsh') {
      const briefed = await briefIfNeeded(ctx, saved.friendId, { bridgeName: saved.bridge, reason: 'bind' })
      saved.data.briefed = briefed.ok ? { chars: briefed.chars } : { error: briefed.error || briefed.reason }
    }
  }
  return saved
}

async function listAllSessions(ctx) {
  const svc = ctx?.sessionController
  if (!svc || typeof svc.list !== 'function') return { sessions: [], reason: '宿主没有 sessionController' }
  try {
    const res = await svc.list({}, signalOf(ctx))
    const items = Array.isArray(res?.items) ? res.items : []
    const out = []
    for (const item of items.slice(0, 60)) {
      let title
      try {
        const q = ctx?.sessionQuery
        if (q && typeof q.readTitle === 'function') title = await q.readTitle(item.sessionId, signalOf(ctx))
      } catch {
        title = undefined
      }
      out.push({
        sessionId: item.sessionId,
        title: typeof title === 'string' ? title : '',
        running: item.running === true,
        blank: item.blank === true,
        updatedAt: Number(item.updatedAt) || 0,
        cwd: item.cwd,
      })
    }
    return { sessions: out }
  } catch (e) {
    return { sessions: [], reason: e instanceof Error ? e.message : String(e) }
  }
}

async function activateRoute(ctx, body) {
  const name = String(body.name || '').trim()
  if (!name) return { ok: false, error: '缺少 name' }
  const found = await read((db, meta) => {
    const r = resolve(db, name)
    if (!r.friend) return { ok: false, error: `没有「${name}」这个鱼友`, meta }
    return { ok: true, friend: JSON.parse(JSON.stringify(r.friend)), meta }
  })
  if (!found.ok) return found
  const f = found.friend
  const binding = sessionBinding(f)
  if (!binding.bound) return { ok: false, error: `${f.name} 还没绑定会话，先绑一个` }
  if (binding.kind === 'url') {
    return { ok: true, data: { name: f.name, kind: 'url', url: binding.ref, opened: true, note: body.note || '' } }
  }
  const desc = await describeSession(ctx, f)
  if (desc.lookupError && desc.exists !== true) {
    return { ok: false, error: desc.lookupError }
  }
  let message = null
  if (body.message) {
    const res = await promptSession(ctx, binding.ref, body.message, { mode: body.mode === 'steer' ? 'steer' : undefined })
    if (!res.ok) return { ok: false, error: `消息没投进去：${res.error}` }
    message = { sent: true, requestId: res.requestId }
  }
  const entry = await mutate((db) => {
    const r = resolve(db, f.name)
    if (!r.friend) return { value: { error: `会话过程中「${f.name}」不见了` } }
    const queued = queueActivation(db, r.friend, { note: body.note || '' })
    return { value: { id: queued?.id || null } }
  })
  return {
    ok: true,
    data: {
      name: f.name,
      kind: 'dsh',
      sessionId: binding.ref,
      title: desc.title,
      running: desc.running === true,
      message,
      activationId: entry?.id || null,
      hint: '面板会用 uiWorkspace.openSession 切过去；切不过去就手动点会话列表。',
    },
  }
}

async function shareRoute(body) {
  const text = String(body.text || '').trim()
  if (!text) return { ok: false, error: '缺少 text' }
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : []
  return mutate((db, meta) => {
    if (!db.friends.length) return { noSave: true, value: { ok: false, error: '鱼友簿还是空的' } }
    let target
    if (body.name) {
      const r = resolve(db, String(body.name))
      if (!r.friend) return { noSave: true, value: { ok: false, error: `没有「${body.name}」这个鱼友` } }
      target = r.friend
    } else {
      target = rankByContent(db.friends, text, tags)[0]?.f
    }
    if (!target) return { noSave: true, value: { ok: false, error: '挑不出人来' } }
    const sent = body.sent === true
    target.log = [...(target.log || []), { at: Date.now(), kind: 'share', text, sent }].slice(-80)
    if (sent) target.lastTalkAt = Date.now()
    target.updatedAt = Date.now()
    return {
      value: {
        ok: true,
        data: { name: target.name, sent, affinity: affinity(target), channelText: channelText(target) },
        meta: metaOf(meta),
      },
    }
  })
}

async function noteRoute(body) {
  const name = String(body.name || '').trim()
  const text = String(body.text || '').trim()
  if (!name || !text) return { ok: false, error: '缺少 name 或 text' }
  return mutate((db, meta) => {
    const r = resolve(db, name)
    if (!r.friend) return { noSave: true, value: { ok: false, error: `没有「${name}」这个鱼友` } }
    const f = r.friend
    f.lastTalkAt = Date.now()
    f.log = [...(f.log || []), { at: f.lastTalkAt, kind: 'talk', text, ...(body.mood ? { mood: String(body.mood) } : {}) }].slice(-80)
    f.updatedAt = Date.now()
    return { value: { ok: true, data: { name: f.name, affinity: affinity(f) }, meta: metaOf(meta) } }
  })
}

async function ackRoute(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : null
  const count = await mutate((db) => {
    const dbIds = ids || pendingActivations(db).map((a) => a.id)
    const n = ackActivations(db, dbIds)
    return { value: n }
  })
  return { ok: true, data: { acked: count } }
}

// ---- v0.4：桥接 / 路由 / 主动闲聊 / 收发 ----

async function bridgeRoute(body) {
  const action = String(body.action || 'list')
  if (action === 'add') {
    const kind = String(body.kind || 'file')
    if (!BRIDGE_KINDS.includes(kind)) return { ok: false, error: `kind 只能是 ${BRIDGE_KINDS.join(' / ')}` }
    return mutate((db, meta) => {
      db.bridges = Array.isArray(db.bridges) ? db.bridges : []
      if (db.bridges.length >= 20) return { noSave: true, value: { ok: false, error: '桥接最多 20 个' } }
      const bridge = {
        id: newBridgeId(kind),
        name: String(body.name || kind).trim() || kind,
        kind,
        enabled: true,
        config: body.config && typeof body.config === 'object' ? { ...body.config } : {},
        createdAt: Date.now(),
        stats: { in: 0, out: 0, errors: 0 },
      }
      db.bridges.push(bridge)
      if (kind === 'file') {
        const dir = bridgeDir(bridge.id)
        try {
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, 'README.txt'),
            ['外来消息：往 in.jsonl 追加一行 JSON', '{"uid":"id","name":"昵称","text":"内容"}', '出站消息写在 out.jsonl'].join('\n'),
            'utf8',
          )
        } catch {
          /* 目录建不出来也不影响记录 */
        }
      }
      return { value: { ok: true, data: { bridge, dir: kind === 'file' ? bridgeDir(bridge.id) : '' }, meta: metaOf(meta) } }
    })
  }
  return mutate((db, meta) => {
    const b = findBridge(db, body.id || body.name)
    if (!b) return { noSave: true, value: { ok: false, error: '没有这个桥接' } }
    if (action === 'remove') db.bridges = db.bridges.filter((x) => x.id !== b.id)
    else if (action === 'toggle') b.enabled = typeof body.enabled === 'boolean' ? body.enabled : !b.enabled
    return { value: { ok: true, data: { bridge: b, removed: action === 'remove' }, meta: metaOf(meta) } }
  })
}

async function routingRoute(ctx, body) {
  if (body.promote) {
    const uid = String(body.uid || '').trim()
    if (!uid) return { ok: false, error: '缺少 uid（不知道给谁建档）' }
    const b = await read((db) => findBridge(db, body.bridgeId || body.bridge || ''))
    if (!b) return { ok: false, error: '没有这个桥接' }
    const r = await promote(ctx, { bridgeId: b.id, bridgeName: b.name, uid, name: body.name, at: Date.now() })
    return {
      ok: true,
      data: {
        friendId: r.friend.id,
        friendName: r.friend.name,
        sessionId: r.friend.session?.ref || '',
        sessionError: r.sessionError || '',
      },
    }
  }
  return mutate((db, meta) => {
    db.settings = db.settings || {}
    const routing = { ...(db.settings.routing || {}) }
    const rate = { ...(db.settings.rate || {}) }
    let list = Array.isArray(routing.sharedSessions) ? routing.sharedSessions.slice() : []
    if (body.clearShared) list = []
    if (body.removeShared) {
      const key = norm(body.removeShared)
      list = list.filter((s) => norm(s.ref) !== key && norm(s.id) !== key)
    }
    if (body.sharedRef) {
      const key = norm(body.sharedRef)
      if (body.addShared) {
        if (!list.some((s) => norm(s.ref) === key)) {
          const made = newSharedSession({ ref: body.sharedRef, label: body.sharedLabel, kind: body.sharedKind, goal: body.sharedGoal !== false })
          if (made) list.push(made)
        }
      } else if (!body.removeShared && body.setGoal === undefined) {
        const made = newSharedSession({ ref: body.sharedRef, label: body.sharedLabel, kind: body.sharedKind, goal: body.sharedGoal !== false })
        list = made ? [made] : []
      }
    }
    if (body.setGoal !== undefined) {
      const key = norm(body.sharedRef)
      list = list.map((s) =>
        norm(s.ref) === key || norm(s.id) === key ? { ...s, goal: body.sharedGoal === true } : s,
      )
    }
    routing.sharedSessions = list.slice(-10)
    if (body.promoteAfter !== undefined) routing.promoteAfter = Math.min(20, Math.max(1, Math.floor(Number(body.promoteAfter) || 3)))
    if (body.workspaceDir !== undefined) routing.workspaceDir = String(body.workspaceDir || '')
    const p2p = { ...(routing.publicToPrivate || {}) }
    if (body.publicToPrivate !== undefined) p2p.enabled = body.publicToPrivate === true
    if (body.publicAfterMessages !== undefined) p2p.afterMessages = Math.min(20, Math.max(1, Math.floor(Number(body.publicAfterMessages) || 2)))
    if (body.publicCooldownHours !== undefined) p2p.cooldownMs = Math.min(7 * 24, Math.max(1, Number(body.publicCooldownHours) || 24)) * 3600000
    if (body.opener !== undefined) p2p.opener = String(body.opener || '').slice(0, 200)
    routing.publicToPrivate = p2p
    if (body.rateWindowMinutes !== undefined) rate.windowMs = Math.max(1, Number(body.rateWindowMinutes) || 60) * 60000
    if (body.rateMax !== undefined) rate.max = Math.max(1, Math.floor(Number(body.rateMax) || 30))
    if (body.clearPending) db.pendingSenders = []
    db.settings.routing = routing
    db.settings.rate = rate
    return {
      value: {
        ok: true,
        data: { routing, rate, sharedSessions: sharedList(db), pendingSenders: (db.pendingSenders || []).length },
        meta: metaOf(meta),
      },
    }
  })
}

/** GET /rhythm：作息；POST /private：手动转私聊；POST /goal：交友目标；POST /merge：合并档案。 */
async function rhythmRoute(url) {
  const name = String(url.searchParams.get('name') || '').trim()
  const days = Math.min(365, Math.max(1, Math.floor(Number(url.searchParams.get('days')) || 30)))
  return read((db, meta) => {
    if (name) {
      const r = resolve(db, name)
      if (!r.friend) return { ok: false, error: `没有「${name}」这个鱼友` }
      return { ok: true, data: { rhythm: analyzeRhythm(db, r.friend, { days }), meta: metaOf(meta) } }
    }
    const rows = (db.friends || [])
      .map((f) => analyzeRhythm(db, f, { days }))
      .filter((a) => a.ok && a.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 50)
      .map((a) => ({ friendId: a.friendId, name: a.friendName, total: a.total, activeHours: a.activeHours, line: rhythmLine(a), peakHour: a.peakHour }))
    return { ok: true, data: { rows, meta: metaOf(meta) } }
  })
}

async function privateRoute(ctx, body) {
  const name = String(body.name || '').trim()
  if (!name) return { ok: false, error: '缺少 name' }
  const snap = await read((db) => ({ friend: resolve(db, name).friend }))
  if (!snap.friend) return { ok: false, error: `没有「${name}」这个鱼友` }
  const r = await inviteToPrivate(ctx, { friend: snap.friend, reason: 'manual', lastText: body.text || '' })
  return { ok: r.ok, data: { name: snap.friend.name, ...r }, error: r.error }
}

async function goalRoute(ctx, body) {
  const action = String(body.action || 'set')
  if (action === 'now') {
    const r = await tickGoal(ctx, { force: body.force !== false })
    return { ok: true, data: r }
  }
  if (action === 'get') return { ok: true, data: { goal: await read((db) => goalStatus(db)) } }
  return mutate((db, meta) => {
    db.settings = db.settings || {}
    const g = { ...(db.settings.goal || {}) }
    if (body.enabled !== undefined) g.enabled = body.enabled === true
    if (body.min !== undefined) g.min = Math.min(50, Math.max(0, Math.floor(Number(body.min) || 0)))
    if (body.max !== undefined) g.max = Math.min(50, Math.max(0, Math.floor(Number(body.max) || 0)))
    if (g.max < g.min) g.max = g.min
    if (body.remindEveryHours !== undefined) g.remindEveryMs = Math.min(24, Math.max(0.25, Number(body.remindEveryHours) || 2)) * 3600000
    if (body.dailyCap !== undefined) g.dailyCap = Math.min(20, Math.max(0, Math.floor(Number(body.dailyCap) || 0)))
    db.settings.goal = g
    return { value: { ok: true, data: { goal: goalStatus(db) }, meta: metaOf(meta) } }
  })
}

async function mergeRoute(body) {
  const from = String(body.from || '').trim()
  const into = String(body.into || '').trim()
  if (!from || !into) return { ok: false, error: '缺少 from / into' }
  return mutate((db, meta) => {
    const a = resolve(db, from)
    const b = resolve(db, into)
    if (!a.friend) return { noSave: true, value: { ok: false, error: `找不到「${from}」` } }
    if (!b.friend) return { noSave: true, value: { ok: false, error: `找不到「${into}」` } }
    const src = a.friend
    const dst = b.friend
    if (src.id === dst.id) return { noSave: true, value: { ok: true, data: { merged: false, name: dst.name }, meta: metaOf(meta) } }
    const key = (c) => `${norm(c.platform)}:${norm(c.uid)}`
    const seen = new Set((dst.channels || []).map(key))
    for (const c of src.channels || []) {
      if (!c || !String(c.platform || '').trim()) continue
      const k = key(c)
      if (seen.has(k)) continue
      seen.add(k)
      dst.channels = dst.channels || []
      dst.channels.push(c)
    }
    const names = new Set([dst.name, ...(dst.aliases || [])].map(norm))
    for (const al of [src.name, ...(src.aliases || [])]) {
      if (!al || names.has(norm(al))) continue
      dst.aliases = dst.aliases || []
      dst.aliases.push(al)
      names.add(norm(al))
    }
    dst.interests = [...new Set([...(dst.interests || []), ...(src.interests || [])])]
    if (!dst.impression && src.impression) dst.impression = src.impression
    dst.log = [...(dst.log || []), ...(src.log || [])].filter((l) => l && l.at).sort((x, y) => x.at - y.at).slice(-80)
    if (!dst.session?.ref && src.session?.ref) dst.session = src.session
    if (!dst.briefed?.sessionRef && src.briefed?.sessionRef) dst.briefed = src.briefed
    dst.lastTalkAt = Math.max(Number(dst.lastTalkAt) || 0, Number(src.lastTalkAt) || 0)
    let moved = 0
    for (const m of db.messages || []) if (m && m.friendId === src.id) { m.friendId = dst.id; moved += 1 }
    for (const h of db.holds || []) if (h && h.friendId === src.id) h.friendId = dst.id
    db.friends = (db.friends || []).filter((f) => f.id !== src.id)
    return { value: { ok: true, data: { merged: true, from: src.name, into: dst.name, moved }, meta: metaOf(meta) } }
  })
}

async function proactiveRoute(ctx, body) {
  const action = String(body.action || 'set')
  if (action === 'now') {
    const r = await tickProactive(ctx, { maxPerTick: 5 })
    return { ok: true, data: r }
  }
  return mutate((db, meta) => {
    db.settings = db.settings || {}
    const g = { ...(db.settings.proactive || {}) }
    if (body.enabled !== undefined) g.enabled = body.enabled === true
    if (body.windowFrom !== undefined) g.windowFrom = Math.min(23, Math.max(0, Math.floor(Number(body.windowFrom))))
    if (body.windowTo !== undefined) g.windowTo = Math.min(23, Math.max(0, Math.floor(Number(body.windowTo))))
    if (body.dailyCap !== undefined) g.dailyCap = Math.min(50, Math.max(0, Math.floor(Number(body.dailyCap))))
    if (body.minGapHours !== undefined) g.minGapMs = Math.max(5, Number(body.minGapHours) || 6) * 3600000
    if (body.maxGapHours !== undefined) g.maxGapMs = Math.max(5, Number(body.maxGapHours) || 72) * 3600000
    if (g.maxGapMs < g.minGapMs) g.maxGapMs = g.minGapMs
    if (body.mode) g.mode = ['template', 'agent'].includes(body.mode) ? body.mode : 'template'
    db.settings.proactive = g
    return { value: { ok: true, data: { proactive: g }, meta: metaOf(meta) } }
  })
}

async function sendRoute(ctx, body) {
  const name = String(body.name || '').trim()
  const text = String(body.text || '').trim()
  if (!name || !text) return { ok: false, error: '缺少 name 或 text' }
  const snap = await read((db, meta) => ({ db, meta, friend: resolve(db, name).friend }))
  if (!snap.friend) return { ok: false, error: `没有「${name}」这个鱼友` }
  const r = await sendToFriend(ctx, snap.db, snap.friend, text, { bridgeId: body.bridge })
  return { ok: r.ok, data: { name: snap.friend.name, ...r }, error: r.error }
}

async function inboundRoute(ctx, body) {
  const b = await read((db) => findBridge(db, body.bridge || ''))
  if (!b) return { ok: false, error: `没有叫「${body.bridge}」的桥接` }
  const r = await ingestIncoming(ctx, {
    bridgeId: b.id,
    bridgeName: b.name,
    uid: body.uid,
    name: body.name,
    text: body.text,
    at: Number(body.at) || Date.now(),
  })
  return { ok: true, data: r }
}

/** 路由本体。ctx 来自插件 apply 的 ctx（要能拿到 sessionController）。 */
export function createHttpHandler(ctx) {
  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) {
      json(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': 'same-origin',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }
    try {
      if (method === 'GET' && route === '/health') {
        json(res, 200, { ok: true, data: { name: 'dsh-fish-friends', prefix: PREFIX, at: Date.now() } })
        return
      }
      if (method === 'GET' && route === '/graph') {
        json(res, 200, await graph(ctx, url))
        return
      }
      if (method === 'GET' && route === '/for') {
        json(res, 200, await forContent(url))
        return
      }
      if (method === 'GET' && route === '/search') {
        json(res, 200, await search(url))
        return
      }
      if (method === 'GET' && route === '/rhythm') {
        json(res, 200, await rhythmRoute(url))
        return
      }
      if (method === 'GET' && route === '/pending') {
        const data = await read((db, meta) => {
          const pending = pendingActivations(db).map((a) => ({ ...a }))
          return { ok: true, data: { pending, meta: metaOf(meta) } }
        })
        json(res, 200, data)
        return
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (route === '/pending/ack') return json(res, 200, await ackRoute(body))
        if (route === '/for') {
          const text = String(body.text || '').trim()
          const tags = Array.isArray(body.tags) ? body.tags.join(',') : String(body.tags || '')
          const limit = body.limit
          const qs = new URLSearchParams({ text, tags, ...(limit ? { limit: String(limit) } : {}) })
          return json(res, 200, await forContent(new URL(`${PREFIX}/for?${qs}`, 'http://127.0.0.1')))
        }
        if (route === '/session') return json(res, 200, await sessionRoute(ctx, body))
        if (route === '/activate') return json(res, 200, await activateRoute(ctx, body))
        if (route === '/share') return json(res, 200, await shareRoute(body))
        if (route === '/note') return json(res, 200, await noteRoute(body))
        if (route === '/bridge') return json(res, 200, await bridgeRoute(body))
        if (route === '/routing') return json(res, 200, await routingRoute(ctx, body))
        if (route === '/proactive') return json(res, 200, await proactiveRoute(ctx, body))
        if (route === '/send') return json(res, 200, await sendRoute(ctx, body))
        if (route === '/inbound') return json(res, 200, await inboundRoute(ctx, body))
        if (route === '/private') return json(res, 200, await privateRoute(ctx, body))
        if (route === '/goal') return json(res, 200, await goalRoute(ctx, body))
        if (route === '/merge') return json(res, 200, await mergeRoute(body))
        if (route === '/release') {
          const r = await import('./routing.js').then((m) => m.releaseHolds(ctx))
          return json(res, 200, { ok: true, data: r })
        }
      }
      json(res, 405, { ok: false, error: `不支持的请求：${method} ${route}` })
    } catch (e) {
      json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { path: PREFIX, handler }
}

export const __test__ = { PREFIX, metaOf, friendCard, DAY, norm }
