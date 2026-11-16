// 桥接层：外来消息从哪进来、出去的消息往哪送。
// 三种内置适配器：
//   file —— 往 <数据目录>/bridges/<桥接id>/in.jsonl 追加一行就是一条外来消息；
//           出站写 out.jsonl。任何真实平台（B站私信、QQ、TG…）只要有个小脚本能读写文件，
//           就能接进来，不需要碰到 webServer 的鉴权。
//   http —— 出站 POST 到 config.sendUrl（{bridgeId,to,name,text}）。
//   mock —— 只记出站，不发网络；测试和演示用。
import fs from 'node:fs'
import path from 'node:path'
import { bridgeDir, safeName, mutate } from './store.js'

export const BRIDGE_KINDS = ['file', 'http', 'mock']

const adapters = {
  file: {
    description: '本地文件桥：in.jsonl 进、out.jsonl 出（任何平台脚本都能接）',
    async send(bridge, msg) {
      const dir = bridgeDir(bridge.id)
      fs.mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({ at: Date.now(), to: msg.to, name: msg.name, text: msg.text, kind: msg.kind || 'reply' })
      fs.appendFileSync(path.join(dir, 'out.jsonl'), `${line}\n`, 'utf8')
      return { ok: true }
    },
  },
  http: {
    description: 'HTTP 桥：出站 POST 到 config.sendUrl',
    async send(bridge, msg) {
      const url = String(bridge?.config?.sendUrl || '').trim()
      if (!url) return { ok: false, error: '这个桥没配 sendUrl' }
      if (typeof fetch !== 'function') return { ok: false, error: '当前运行时不支持 fetch' }
      const headers = { 'content-type': 'application/json' }
      if (bridge.config.token) headers.authorization = `Bearer ${bridge.config.token}`
      if (bridge.config.headers && typeof bridge.config.headers === 'object') Object.assign(headers, bridge.config.headers)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ bridgeId: bridge.id, to: msg.to, name: msg.name, text: msg.text, kind: msg.kind || 'reply' }),
        })
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  },
  mock: {
    description: '空桥：只记出站，不联网（测试用）',
    async send() {
      return { ok: true }
    },
  },
}

export function bridgeAdapter(kind) {
  return adapters[String(kind || 'file')] || null
}

export function newBridgeId(kind) {
  return `b_${safeName(kind || 'file')}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
}

// ---- 出站 ----

/**
 * 把一条消息交给桥发出去：先落 outbox（发失败还能重试），再调适配器。
 * 返回 {ok, outboxId, error}
 */
export async function sendViaBridge({ bridge, to, name, text, kind = 'reply' }) {
  const adapter = bridgeAdapter(bridge?.kind)
  if (!adapter) return { ok: false, error: `未知桥接类型：${bridge?.kind}` }
  if (!bridge || bridge.enabled === false) return { ok: false, error: '这个桥是停用状态' }
  const target = String(to || '').trim()
  if (!target) return { ok: false, error: '不知道发给谁（缺 uid）' }
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '消息是空的' }
  try {
    const r = await adapter.send(bridge, { to: target, name: String(name || ''), text: body, kind })
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '发送失败' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- 入站（file 桥轮询） ----

// 每个桥的读取游标：第一次启动直接跳到文件末尾，避免把历史消息重放一遍
// （旧消息已经处理过；真要重放用 friends_inbox 手动喂）。
// 游标一律按 **字节** 记（Buffer），不能用字符串下标：中文一行 10 个字却是 30 字节，
// 混用会让「text.length < offset」永远成立 → 每秒从头重读 → 同一消息重复投递。
const cursors = new Map()
const EMPTY_BUF = Buffer.alloc(0)

function cursorFor(bridge) {
  const key = bridge.id
  if (cursors.has(key)) return cursors.get(key)
  const dir = bridgeDir(bridge.id)
  const file = path.join(dir, 'in.jsonl')
  let offset = 0
  try {
    offset = fs.statSync(file).size
  } catch {
    offset = 0
  }
  const state = { offset, partial: EMPTY_BUF }
  cursors.set(key, state)
  return state
}

/** 清掉某个桥的游标（桥被删/停用后可复用 id 时用；测试也用它重置）。 */
export function resetFileCursor(bridgeId) {
  cursors.delete(bridgeId)
}

/** 读一个 file 桥的新增行，返回 [{uid,name,text,at}]。非 JSON 行跳过并记一次错误。 */
export function drainFileBridge(bridge) {
  const dir = bridgeDir(bridge.id)
  const file = path.join(dir, 'in.jsonl')
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return []
  }
  const st = cursorFor(bridge)
  if (buf.length < st.offset) {
    // 文件被截断/重写：从头再来
    st.offset = 0
    st.partial = EMPTY_BUF
  }
  const chunk = buf.subarray(st.offset)
  if (!chunk.length) return []
  const end = chunk.lastIndexOf(0x0a) // '\n'
  if (end < 0) return [] // 只有半行，等下次（游标不动，不吞不重）
  const complete = st.partial.length ? Buffer.concat([st.partial, chunk.subarray(0, end + 1)]) : chunk.subarray(0, end + 1)
  st.partial = EMPTY_BUF
  st.offset += end + 1 // 纯字节推进，与编码无关
  const out = []
  for (const line of complete.toString('utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const raw = JSON.parse(t)
      const uid = String(raw.uid ?? raw.from ?? raw.id ?? '').trim()
      const body = String(raw.text ?? raw.content ?? raw.message ?? '').trim()
      if (!uid || !body) continue
      out.push({
        uid,
        name: String(raw.name ?? raw.nick ?? '').trim(),
        text: body,
        at: Number(raw.at) || Date.now(),
      })
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

// ---- 运行时：轮询所有 file 桥 + 重试 outbox ----

/** 运行时状态（面板/工具看：跑没跑、最近错误）。 */
export const runtime = { running: false, startedAt: 0, errors: [] }

/**
 * 启动桥接运行时。返回 stop()。
 * ingest(msg) 由 routing 层提供：{bridgeId, bridgeName, uid, name, text, at}
 */
export function startBridgeRuntime({ readDb, ingest, onError, pollMs = 1000, retryMs = 15000 }) {
  let stopped = false
  let pollTimer = null
  let retryTimer = null
  const errors = runtime.errors
  const startedAt = Date.now()
  runtime.running = true
  runtime.startedAt = startedAt

  const noteError = (e) => {
    const text = e instanceof Error ? e.message : String(e)
    errors.push({ at: Date.now(), text })
    if (errors.length > 20) errors.shift()
    if (typeof onError === 'function') {
      try {
        onError(text)
      } catch {
        /* 忽略 */
      }
    }
  }

  const poll = () => {
    if (stopped) return
    try {
      const r = readDb()
      const bridges = Array.isArray(r?.db?.bridges) ? r.db.bridges : []
      for (const bridge of bridges) {
        if (!bridge || bridge.enabled === false) continue
        if (String(bridge.kind) !== 'file') continue
        let rows = []
        try {
          rows = drainFileBridge(bridge)
        } catch (e) {
          noteError(e)
          continue
        }
        for (const row of rows) {
          try {
            ingest({ bridgeId: bridge.id, bridgeName: bridge.name, ...row })
          } catch (e) {
            noteError(e)
          }
        }
      }
    } catch (e) {
      noteError(e)
    }
  }

  const retry = async () => {
    if (stopped) return
    try {
      const r = readDb()
      const bridges = Array.isArray(r?.db?.bridges) ? r.db.bridges : []
      const outbox = Array.isArray(r?.db?.outbox) ? r.db.outbox : []
      const pending = outbox.filter((o) => o.status === 'pending' && o.tries < 3).slice(0, 20)
      for (const item of pending) {
        const bridge = bridges.find((b) => b.id === item.bridgeId)
        if (!bridge) continue
        const sent = await sendViaBridge({ bridge, to: item.to, name: item.name, text: item.text, kind: item.kind })
        try {
          await mutate((db) => {
            const row = (db.outbox || []).find((o) => o.id === item.id)
            if (!row) return { noSave: true }
            row.tries = (Number(row.tries) || 0) + 1
            if (sent.ok) {
              row.status = 'sent'
              row.sentAt = Date.now()
              row.error = ''
            } else {
              row.error = String(sent.error || '')
              if (row.tries >= 3) row.status = 'failed'
            }
            return undefined
          })
        } catch (e) {
          noteError(e)
        }
      }
    } catch (e) {
      noteError(e)
    }
  }

  pollTimer = setInterval(poll, pollMs)
  retryTimer = setInterval(() => void retry(), retryMs)
  const initial = setTimeout(poll, 50)
  void retry()

  return () => {
    stopped = true
    runtime.running = false
    if (pollTimer) clearInterval(pollTimer)
    if (retryTimer) clearInterval(retryTimer)
    clearTimeout(initial)
  }
}
