// 鱼友簿 v2：记联系方式、爱好、亲密度（自己算），按内容找最合适的人。
// 数据落在 $DSH_HOME/fish-friends/friends.json，纯本地，不联网。
import fs from 'node:fs'
import path from 'node:path'
import { read, mutate, resolve, findExact, norm, newId, bridgeDir, safeName, workspaceFor, workspaceRoot, newSharedSession } from './store.js'
import { affinity, brief, rankByContent, searchScore, channelText, sessionText } from './score.js'
import { describeSession, listSessions, promptSession, queueActivation, sessionBinding, createSession, signalOf } from './session.js'
import { BRIDGE_KINDS, bridgeAdapter, newBridgeId, runtime as bridgeRuntime, sendViaBridge } from './bridge.js'
import {
  effectiveRate,
  findBridge,
  findFriendBySender,
  ingestIncoming,
  inboundCount,
  inviteToPrivate,
  ensureSession,
  sendToFriend,
  releaseHolds,
  sharedList,
} from './routing.js'
import { briefIfNeeded, resendBriefing } from './briefing.js'
import { analyzeRhythm, rhythmLine, nextActiveAt, activeNow, hoursText } from './rhythm.js'
import { goalStatus, goalLine, tickGoal, GOAL_ACTIVE_FROM, GOAL_ACTIVE_TO } from './goal.js'
import {
  dueProactive,
  jitteredGapMs,
  nextDuePreview,
  proactiveConfig,
  proactiveSentToday,
  targetGapMs,
  tickProactive,
  inWindow,
} from './proactive.js'

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function metaPrefix(meta) {
  if (!meta) return ''
  const lines = []
  if (meta.status === 'corrupt') {
    lines.push(`⚠️ 数据文件损坏${meta.corruptCopy ? `，原文件已备份为 ${meta.corruptCopy}` : ''}，当前在空库上操作。`)
  } else if (meta.status === 'error') {
    lines.push(`⚠️ 读取数据失败：${meta.error}`)
  }
  if (Array.isArray(meta.warnings)) lines.push(...meta.warnings.map((w) => `⚠️ ${w}`))
  return lines.length ? lines.join('\n') + '\n' : ''
}

function noMatchText(name, r) {
  if (r.how === 'ambiguous') {
    return `❌ 「${name}」有 ${r.candidates.length} 个相近的人：${r.candidates.map((f) => f.name).join('、')}。请用完整名字。`
  }
  return `❌ 鱼友簿里没有「${name}」，先用 friends_upsert 记一下。`
}

export function registerTools(ctx) {
  const TEXT_OUTPUT = {
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
  const register = (definition, label) => {
    const withOutput = definition.output ? definition : { ...definition, output: TEXT_OUTPUT }
    ctx.effect(() => ctx.tools.register(withOutput), label)
  }

  register({
    name: 'friends_upsert',
    description: '记一条鱼友或更新已有的：名字必填。可记爱好、联系通道（平台+id+怎么发）、印象、别名、专属会话。只按完整名字/别名/id 更新，不模糊并档。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        platform: { type: 'string', description: 'bilibili / qq / 贴吧 / 其他' },
        uid: { type: 'string' },
        interests: { type: 'array', items: { type: 'string' }, description: 'TA 爱聊什么，比如 大肥鱼 / 龙珠 / 德州扑克' },
        channels: {
          type: 'array',
          description: '联系通道（发消息的地方）',
          items: {
            type: 'object',
            properties: { platform: { type: 'string' }, uid: { type: 'string' }, kind: { type: 'string', description: '私信 / 评论 / 群 / 会话' } },
          },
        },
        impression: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        session: {
          type: 'object',
          description: '给 TA 安排的专属会话（可选）：kind=dsh/platform/url/custom，ref 是会话 id 或地址，label 是给人看的名字',
          properties: { kind: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' } },
        },
      },
      required: ['name'],
    },
    execute: async (args = {}) => {
      const nm = String(args.name || '').trim()
      if (!nm) return { text: '❌ 名字不能空' }
      const { platform, uid, interests, channels, impression, aliases, session } = args
      return mutate((db, meta) => {
        const exact = findExact(db, nm)
        const f = exact?.friend
        const created = !f
        const fuzzy = created
          ? db.friends.filter((x) => norm(x.name).includes(norm(nm)) || norm(nm).includes(norm(x.name)))
          : []
        let target = f
        if (!target) {
          target = { id: newId(), name: nm, createdAt: Date.now(), updatedAt: Date.now(), log: [], aliases: [], interests: [], channels: [] }
          db.friends.push(target)
        }
        if (platform) target.platform = String(platform)
        if (uid) target.uid = String(uid)
        if (Array.isArray(interests) && interests.length) target.interests = [...new Set([...(target.interests || []), ...interests.map(String)])]
        if (Array.isArray(channels) && channels.length) {
          for (const c of channels) {
            if (!c || !c.platform) continue
            const exists = (target.channels || []).find((x) => x.platform === c.platform && String(x.uid || '') === String(c.uid || ''))
            if (exists) Object.assign(exists, { platform: c.platform, uid: String(c.uid || ''), kind: c.kind || exists.kind || '会话' })
            else (target.channels ||= []).push({ platform: c.platform, uid: String(c.uid || ''), kind: c.kind || '会话' })
          }
        }
        if (impression) target.impression = String(impression)
        if (Array.isArray(aliases) && aliases.length) target.aliases = [...new Set([...(target.aliases || []), ...aliases.map(String)])]
        if (session && session.ref) {
          target.session = { kind: String(session.kind || 'dsh'), ref: String(session.ref), label: session.label ? String(session.label) : '' }
        }
        target.updatedAt = Date.now()
        const warn = fuzzy.length
          ? `\n⚠️ 备注：已有相似记录「${fuzzy.map((x) => x.name).join('、')}」。如果是同一个人，请改用完整名字更新；这次按新朋友记。`
          : ''
        return { value: { text: `${metaPrefix(meta)}${created ? '记下了' : '更新了'}：${brief(target)}${warn}` } }
      })
    },
  }, 'fish-friends:upsert')

  register({
    name: 'friends_note',
    description: '给某个鱼友记一条互动：聊了什么、感觉怎么样。会更新「上次说话」，亲密度跟着变。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        mood: { type: 'string', description: '顺 / 尬 / TA 先开口' },
      },
      required: ['name', 'text'],
    },
    execute: async ({ name, text, mood } = {}) =>
      mutate((db, meta) => {
        const r = resolve(db, name)
        if (!r.friend) return { noSave: true, value: { text: metaPrefix(meta) + noMatchText(name, r) } }
        const f = r.friend
        f.lastTalkAt = Date.now()
        f.log = [...(f.log || []), { at: f.lastTalkAt, kind: 'talk', text: String(text || ''), ...(mood ? { mood: String(mood) } : {}) }].slice(-80)
        f.updatedAt = Date.now()
        return { value: { text: `${metaPrefix(meta)}记好了：${f.name}｜${text}${mood ? `（${mood}）` : ''}｜现在亲密 ${affinity(f)}` } }
      }),
  }, 'fish-friends:note')

  register({
    name: 'friends_list',
    description: '列出鱼友簿：名字、联系通道、亲密度、多久没说话、爱看什么。人少时用；按主题找人用 friends_search / friends_for。',
    parameters: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['name', 'recent', 'stale', 'close'], description: '默认 close（最亲的在前）' },
        limit: { type: 'number', description: '最多列几个人，默认全部' },
      },
    },
    execute: async ({ sort = 'close', limit } = {}) =>
      read((db, meta) => {
        if (!db.friends.length) return { text: metaPrefix(meta) + '鱼友簿还是空的，用 friends_upsert 先把认识的鱼记下来。' }
        const list = [...db.friends]
        if (sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
        else if (sort === 'recent') list.sort((a, b) => (b.lastTalkAt || 0) - (a.lastTalkAt || 0))
        else if (sort === 'stale') list.sort((a, b) => (a.lastTalkAt || 0) - (b.lastTalkAt || 0))
        else list.sort((a, b) => affinity(b) - affinity(a))
        const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : list.length
        const shown = list.slice(0, cap)
        const more = list.length > shown.length ? `\n（共 ${list.length} 人，先看前 ${shown.length} 个；要看更多加 limit）` : ''
        return {
          text: metaPrefix(meta) + shown.map((f) => `- ${brief(f)}${f.impression ? `\n    印象：${f.impression}` : ''}`).join('\n') + more,
        }
      }),
  }, 'fish-friends:list')

  register({
    name: 'friends_due',
    description: '谁该去看看了：超过 N 天没说话的（默认 7 天）。',
    parameters: { type: 'object', properties: { days: { type: 'number' } } },
    execute: async ({ days = 7 } = {}) =>
      read((db, meta) => {
        if (!db.friends.length) return { text: metaPrefix(meta) + '鱼友簿还是空的。' }
        const due = db.friends.filter((f) => {
          const d = f.lastTalkAt ? Math.floor((Date.now() - f.lastTalkAt) / 86400000) : null
          return d === null || d >= days
        })
        if (!due.length) return { text: `都还热着，没有超过 ${days} 天没说话的。` }
        return { text: `该去看看（超过 ${days} 天）：\n` + due.map((f) => `- ${brief(f)}`).join('\n') }
      }),
  }, 'fish-friends:due')

  register({
    name: 'friends_show',
    description: '看某个鱼友的档案：基本信息、爱好、亲密度、专属会话、最近互动。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async ({ name } = {}) =>
      read((db, meta) => {
        const r = resolve(db, name)
        if (!r.friend) return { text: metaPrefix(meta) + noMatchText(name, r) }
        const f = r.friend
        const lines = [
          brief(f),
          f.impression ? `印象：${f.impression}` : '',
          f.session?.ref ? `会话：${sessionText(f)}` : '会话：还没绑定（friends_session 可绑定）',
          f.aliases?.length ? `别名：${f.aliases.join('、')}` : '',
          f.log?.length
            ? '最近：' + f.log.slice(-10).map((l) => `\n  ${new Date(l.at).toLocaleDateString('zh-CN')} ${l.kind === 'share' ? (l.sent ? '［分享·已发］' : '［分享·待发］') : '［聊过］'}${l.text}${l.mood ? `（${l.mood}）` : ''}`).join('')
            : '还没记过互动',
        ].filter(Boolean)
        return { text: metaPrefix(meta) + lines.join('\n') }
      }),
  }, 'fish-friends:show')

  register({
    name: 'friends_search',
    description: '按关键词找人：名字、别名、爱好、印象、最近聊过什么。只返回命中的人，不用先把整本鱼友簿读一遍。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，比如 塔防 / 阿蓝 / 龙珠' },
        limit: { type: 'number', description: '最多几个，默认 5' },
      },
      required: ['query'],
    },
    execute: async ({ query, limit = 5 } = {}) =>
      read((db, meta) => {
        const q = String(query || '').trim()
        if (!q) return { text: '❌ 给个关键词，比如 塔防 / 阿蓝 / 龙珠' }
        if (!db.friends.length) return { text: metaPrefix(meta) + '鱼友簿还是空的。' }
        const hits = db.friends
          .map((f) => ({ f, hit: searchScore(f, q) }))
          .filter((x) => x.hit)
          .sort((a, b) => b.hit.score - a.hit.score)
          .slice(0, Math.max(1, Math.floor(Number(limit) || 5)))
        if (!hits.length) {
          return { text: metaPrefix(meta) + `没有匹配「${q}」的鱼友（共 ${db.friends.length} 人）。换个词，或用 friends_list 看全部。` }
        }
        return {
          text: metaPrefix(meta) + hits.map((x) => `- ${x.f.name}｜亲密 ${affinity(x.f)}｜${x.hit.field}：${x.hit.hit}`).join('\n') + `\n（共 ${db.friends.length} 人，命中 ${hits.length} 个）`,
        }
      }),
  }, 'fish-friends:search')

  register({
    name: 'friends_for',
    description: '手里有一条想分享的内容：说清它是什么，直接算出该发给谁（含理由、通道、会话），不用先把整本鱼友簿读一遍。默认只推最合适的那个。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这条内容是什么：标题 + 一两句描述' },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词，比如 大肥鱼 / 塔防 / 军事' },
        limit: { type: 'number', description: '最多给几个人，默认按设置（现在 1）' },
        exclude: { type: 'array', items: { type: 'string' }, description: '排除谁（刚发过的）' },
        minScore: { type: 'number', description: '低于这个分就不推，默认 0' },
      },
      required: ['text'],
    },
    execute: async ({ text, tags = [], limit, exclude = [], minScore = 0 } = {}) =>
      read((db, meta) => {
        if (!db.friends.length) return { text: metaPrefix(meta) + '鱼友簿还是空的，没人可分。' }
        const cap = Math.max(1, Math.floor(Number(limit || db.settings.shareLimit || 1)))
        const ranked = rankByContent(db.friends, text, tags, exclude)
        const top = ranked.slice(0, cap)
        const rest = ranked.slice(cap).filter((r) => r.score >= Math.max(20, Number(minScore) || 0)).slice(0, 2)
        if (!top.length || top[0].score < Number(minScore || 0)) {
          return { text: metaPrefix(meta) + `这条没找到合适的（最高 ${top[0]?.score ?? 0} 分）。要么换个说法，要么先给鱼友补爱好。` }
        }
        const lines = top.map((r, i) => {
          const f = r.f
          const ch = channelText(f) || '还没记通道'
          const ses = f.session?.ref ? sessionText(f) : ''
          return `${top.length > 1 ? `${i + 1}. ` : '发给：'}${f.name}（${r.score} 分）\n   理由：${r.reasons.join('；')}\n   通道：${ch}${ses ? `\n   会话：${ses}` : ''}`
        })
        const note = top[0].score < 20 ? '\n⚠️ 分数不高，不太对口，发之前先聊两句。' : ''
        const alt = rest.length ? `\n备选：${rest.map((r) => `${r.f.name}（${r.score}）`).join('、')}` : ''
        return { text: metaPrefix(meta) + lines.join('\n') + note + alt }
      }),
  }, 'fish-friends:for')

  register({
    name: 'friends_share',
    description: '把一条内容记成「分享给谁」：指定名字或自动挑最合适的。只登记，发送仍用各自脚本。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '分享什么：标题/链接 + 一句你的话' },
        name: { type: 'string', description: '指定给谁；不填就自动挑' },
        tags: { type: 'array', items: { type: 'string' } },
        sent: { type: 'boolean', description: '是否已发出，默认 false（待发）' },
      },
      required: ['text'],
    },
    execute: async ({ text, name, tags = [], sent = false } = {}) =>
      mutate((db, meta) => {
        if (!db.friends.length) return { noSave: true, value: { text: metaPrefix(meta) + '鱼友簿还是空的。' } }
        let target = null
        let why = ''
        if (name) {
          const r = resolve(db, name)
          if (!r.friend) return { noSave: true, value: { text: metaPrefix(meta) + noMatchText(name, r) } }
          target = r.friend
        } else {
          const ranked = rankByContent(db.friends, text, tags)
          target = ranked[0]?.f
          why = ranked[0]?.reasons.join('；') || ''
        }
        if (!target) return { noSave: true, value: { text: '❌ 挑不出人来。' } }
        target.log = [...(target.log || []), { at: Date.now(), kind: 'share', text: String(text || ''), sent: Boolean(sent) }].slice(-80)
        if (sent) target.lastTalkAt = Date.now()
        target.updatedAt = Date.now()
        const ch = channelText(target) || '还没记通道'
        return {
          value: {
            text: `${metaPrefix(meta)}${sent ? '已算作发出' : '先记着'}：给 ${target.name}${why ? `（因为 ${why}）` : ''}\n通道：${ch}\n内容：${text}`,
          },
        }
      }),
  }, 'fish-friends:share')

  register({
    name: 'friends_session',
    description: '给某个鱼友绑定/查看/清除专属会话（每个人可以在不同会话里聊）。kind=dsh/platform/url/custom，ref 是会话 id 或地址。也可以 list 看宿主最近的会话、create 新建一个再绑定。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '鱼友名字；list 时可不填' },
        kind: { type: 'string', description: 'dsh / platform / url / custom，默认 dsh' },
        ref: { type: 'string', description: '会话 id 或地址；不填就是查看' },
        label: { type: 'string', description: '给人看的名字' },
        clear: { type: 'boolean', description: '清掉绑定' },
        list: { type: 'boolean', description: '列出宿主最近的会话（带标题），用来挑 ref' },
        create: { type: 'boolean', description: '新建一个 DSH 会话并绑定给这个鱼友' },
        cwd: { type: 'string', description: 'create 时的工作目录（可选）' },
        force: { type: 'boolean', description: '会话列表里查不到也照样绑定（比如刚建、列表没刷新）' },
        rebrief: { type: 'boolean', description: '重新给已绑定的会话投一条「交接记忆」（TA 是谁、聊过什么），不传 ref 时就是对当前会话重发' },
      },
    },
    execute: async ({ name, kind = 'dsh', ref, label, clear = false, list = false, create = false, cwd, force = false, rebrief = false } = {}) => {
      if (list) {
        const listed = await listSessions(ctx)
        if (!listed.ok) return { text: `❌ ${listed.reason}` }
        if (!listed.items.length) return { text: '宿主里还没有会话。' }
        const rows = []
        for (const item of listed.items.slice(0, 12)) {
          let title = ''
          try {
            const q = ctx?.sessionQuery
            if (q && typeof q.readTitle === 'function') title = (await q.readTitle(item.sessionId, signalOf(ctx))) || ''
          } catch {
            title = ''
          }
          rows.push(`- ${item.sessionId}${title ? `｜${title}` : ''}${item.running ? '｜在跑' : ''}`)
        }
        return { text: `最近的会话（${listed.items.length} 个，显示前 ${rows.length} 个）：\n${rows.join('\n')}` }
      }
      if (!name) return { text: '❌ 要指定鱼友名字（除非用 list）。' }
      if (rebrief) {
        const found = await read((db) => {
          const r = resolve(db, name)
          return r.friend ? { id: r.friend.id, name: r.friend.name, session: r.friend.session || null } : null
        })
        if (!found) return { text: `❌ 鱼友簿里没有「${name}」。` }
        if (!found.session?.ref) return { text: `❌ ${found.name} 还没绑定会话；先 friends_session({name:"${found.name}", ref:"session-…"})。` }
        const b = await resendBriefing(ctx, found.id, { reason: 'bind' })
        if (b.ok) return { text: `✅ 已把「${found.name}」的交接记忆重新投进 ${b.sessionId}（${b.chars} 字）：TA 是谁、聊过什么、要怎么回。` }
        return { text: `❌ 交接记忆没投进去：${b.error || b.reason}` }
      }
      if (create) {
        const made = await createSession(ctx, { cwd })
        if (!made.ok) return { text: `❌ 新建会话失败：${made.error}` }
        ref = made.sessionId
        label = label || '新建的会话'
      }
      if (clear) {
        return mutate((db, meta) => {
          const r = resolve(db, name)
          if (!r.friend) return { noSave: true, value: { text: metaPrefix(meta) + noMatchText(name, r) } }
          const f = r.friend
          delete f.session
          f.updatedAt = Date.now()
          return { value: { text: `${metaPrefix(meta)}已清掉 ${f.name} 的会话绑定。` } }
        })
      }
      if (!ref) {
        return read((db, meta) => {
          const r = resolve(db, name)
          if (!r.friend) return { text: metaPrefix(meta) + noMatchText(name, r) }
          const f = r.friend
          return {
            text:
              metaPrefix(meta) +
              `${f.name} 的会话：${f.session?.ref ? sessionText(f) : '还没绑定'}\n` +
              `绑定：friends_session({name, kind:"dsh", ref:"session-…"})；不知道 id 就加 list:true 看最近的会话，或 create:true 新建一个。`,
          }
        })
      }
      // 绑定前先核对：dsh 会话在不在宿主列表里
      if (String(kind) === 'dsh' && !force) {
        const listed = await listSessions(ctx)
        if (listed.ok && !listed.items.some((item) => String(item.sessionId) === String(ref))) {
          return { text: `❌ 会话列表里没有 ${ref}。先 friends_session({list:true}) 挑一个，或 create:true 新建；确认它真的存在就加 force:true。` }
        }
      }
      const saved = await mutate((db, meta) => {
        const r = resolve(db, name)
        if (!r.friend) return { noSave: true, value: { text: metaPrefix(meta) + noMatchText(name, r) } }
        const f = r.friend
        f.session = { kind: String(kind || 'dsh'), ref: String(ref), label: label ? String(label) : '' }
        f.updatedAt = Date.now()
        return {
          value: {
            text: `${metaPrefix(meta)}已绑定：${f.name} → ${sessionText(f)}`,
            friendId: f.id,
            friendName: f.name,
            bridge: (f.channels || [])[0]?.kind || '',
          },
        }
      })
      if (saved?.friendId && String(kind) === 'dsh') {
        const briefed = await briefIfNeeded(ctx, saved.friendId, { bridgeName: saved.bridge, reason: 'bind' })
        if (briefed.ok) saved.text += `\n已把「${saved.friendName} 是谁、聊过什么」投进这个会话（${briefed.chars} 字），新会话不会两眼一抹黑。`
        else if (!briefed.skipped) saved.text += `\n⚠️ 交接记忆没投进去：${briefed.error || briefed.reason}`
      }
      return saved
    },
  }, 'fish-friends:session')

  register({
    name: 'friends_activate',
    description: '激活某个鱼友的专属会话：可以顺手投一条消息进去（会唤醒冷会话），并让已打开的面板切到那个会话。之后的操作就在那个会话里继续。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string', description: '要投进这个会话的消息（可选）；给了就会真的发过去' },
        mode: { type: 'string', enum: ['followup', 'steer'], description: 'steer=插到当前回合，默认排队' },
        note: { type: 'string', description: '为什么激活（写给自己看）' },
        jump: { type: 'boolean', description: '是否请求面板切过去，默认 true' },
      },
      required: ['name'],
    },
    execute: async ({ name, text, mode, note, jump = true } = {}) => {
      const found = await read((db, meta) => {
        const r = resolve(db, name)
        return { friend: r.friend ? JSON.parse(JSON.stringify(r.friend)) : null, how: r.how, candidates: r.candidates.map((f) => f.name), meta }
      })
      if (!found.friend) return { text: metaPrefix(found.meta) + noMatchText(name, found) }
      const f = found.friend
      const binding = sessionBinding(f)
      if (!binding.bound) {
        return { text: `${metaPrefix(found.meta)}❌ ${f.name} 还没绑定会话。先 friends_session({name:"${f.name}", kind:"dsh", ref:"session-…"})；不知道 id 就加 list:true。` }
      }
      const lines = [`${f.name} 的会话：${binding.kind}:${binding.ref}${binding.label ? `（${binding.label}）` : ''}`]
      if (binding.kind === 'url') {
        if (jump !== false) {
          await mutate((db) => {
            const r = resolve(db, f.name)
            if (r.friend) queueActivation(db, r.friend, { note })
            return { value: null }
          })
        }
        return { text: `${metaPrefix(found.meta)}🔗 这是一个网页会话：${binding.ref}\n${jump !== false ? '已请求面板打开它（面板没开就手动打开这个地址）。' : ''}` }
      }
      const desc = await describeSession(ctx, f)
      if (desc.lookupError && desc.exists !== true) {
        return { text: `${metaPrefix(found.meta)}❌ ${desc.lookupError}\n（会话可能被删了或不在当前 profile；用 friends_session 重新绑一次）` }
      }
      lines.push(
        `状态：${desc.exists === false ? '列表里没找到' : desc.running ? '正在运行' : '空闲'}${desc.title ? `｜标题：${desc.title}` : ''}`,
      )
      // 冷会话被唤醒时同样可能「失忆」：先补交接记忆，再投用户要投的话
      const briefed = await briefIfNeeded(ctx, f.id, { bridgeName: '', reason: 'first' })
      if (briefed.ok && !briefed.skipped) lines.push(`已先投交接记忆（${briefed.chars} 字）：TA 是谁、聊过什么。`)
      if (text) {
        const sent = await promptSession(ctx, binding.ref, text, { mode })
        lines.push(sent.ok ? `✅ 消息已投进去（requestId ${sent.requestId}），冷会话会被一并唤醒。` : `❌ 消息没投进去：${sent.error}`)
        if (!sent.ok) return { text: metaPrefix(found.meta) + lines.join('\n') }
      }
      if (jump !== false) {
        const queued = await mutate((db) => {
          const r = resolve(db, f.name)
          if (!r.friend) return { value: null }
          return { value: queueActivation(db, r.friend, { note }) }
        })
        lines.push(
          queued
            ? `↪️ 已请求面板切到该会话（队列 ${queued.id}）：面板开着就会自动跳；没开就手动点左侧会话列表。`
            : '⚠️ 会话绑定在激活时不见了，没能排进切会话队列。',
        )
      }
      return { text: metaPrefix(found.meta) + lines.join('\n') }
    },
  }, 'fish-friends:activate')

  // ---- 桥接 ----

  register({
    name: 'friends_bridge',
    description:
      '管理「桥接」：外来消息从哪进来、回复往哪送。kind=file（本地 jsonl，任何平台脚本都能接）、http（出站 POST）、mock（测试）。add 之后把收到的消息写进 in.jsonl 就会自动进会话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'toggle', 'test'], description: '默认 list' },
        id: { type: 'string', description: '桥接 id（remove/toggle/test 用）' },
        name: { type: 'string', description: '桥接名字（add 用；也可用名字指定 remove/toggle）' },
        kind: { type: 'string', enum: BRIDGE_KINDS, description: 'file / http / mock' },
        config: { type: 'object', description: 'file: {dir 可选}；http: {sendUrl, token, headers}' },
        enabled: { type: 'boolean', description: 'toggle 时用；不传就取反' },
        to: { type: 'string', description: 'test 时发给谁（对方 uid）' },
        text: { type: 'string', description: 'test 时发什么' },
      },
    },
    execute: async ({ action = 'list', id, name, kind = 'file', config, enabled, to, text } = {}) => {
      const findIt = (db) => {
        const key = norm(id || name)
        return (db.bridges || []).find((b) => norm(b.id) === key || norm(b.name) === key) || null
      }
      if (action === 'list') {
        return read((db, meta) => {
          const bs = db.bridges || []
          const lines = [`桥接运行时：${bridgeRuntime.running ? '在跑' : '没启动'}`]
          if (!bs.length) lines.push('还没有桥接。用 friends_bridge({action:"add", name:"B站私信", kind:"file"}) 建一个。')
          for (const b of bs) {
            lines.push(
              `- ${b.id}｜${b.name}｜${b.kind}${b.enabled ? '' : '（停用）'}｜收 ${b.stats?.in || 0} 发 ${b.stats?.out || 0} 错 ${b.stats?.errors || 0}`,
            )
            if (b.kind === 'file') lines.push(`   收件：${path.join(bridgeDir(b.id), 'in.jsonl')}`)
            if (b.kind === 'http') lines.push(`   出站：${b.config?.sendUrl || '（没配 sendUrl）'}`)
          }
          return { text: metaPrefix(meta) + lines.join('\n') }
        })
      }
      if (action === 'add') {
        if (!BRIDGE_KINDS.includes(String(kind))) return { text: `❌ kind 只能是 ${BRIDGE_KINDS.join(' / ')}` }
        return mutate((db, meta) => {
          db.bridges = Array.isArray(db.bridges) ? db.bridges : []
          if (db.bridges.length >= 20) return { noSave: true, value: { text: '❌ 桥接最多 20 个，先删掉不用的。' } }
          const bridge = {
            id: newBridgeId(kind),
            name: String(name || kind).trim() || String(kind),
            kind: String(kind),
            enabled: true,
            config: config && typeof config === 'object' ? { ...config } : {},
            createdAt: Date.now(),
            stats: { in: 0, out: 0, errors: 0 },
          }
          db.bridges.push(bridge)
          let hint = ''
          if (bridge.kind === 'file') {
            const dir = bridgeDir(bridge.id)
            try {
              fs.mkdirSync(dir, { recursive: true })
              fs.writeFileSync(
                path.join(dir, 'README.txt'),
                [
                  `桥接：${bridge.name}（${bridge.id}）`,
                  '',
                  '外来消息：往 in.jsonl 追加一行 JSON（脚本每收到一条就 append 一行）：',
                  '  {"uid":"对方的id","name":"对方昵称","text":"消息内容","at":1700000000000}',
                  '发出去的消息会写到 out.jsonl，格式：{"at":...,"to":...,"text":...}',
                  '平台脚本只要会写 in.jsonl，就能把消息接进来；机器人回复用 friends_send 发，会落 out.jsonl。',
                ].join('\n'),
                'utf8',
              )
            } catch (e) {
              hint = `\n⚠️ 目录建不出来：${e instanceof Error ? e.message : e}`
            }
            hint += `\n收件文件：${path.join(dir, 'in.jsonl')}`
          }
          return { value: { text: `${metaPrefix(meta)}✅ 建好桥接：${bridge.name}（${bridge.id}，${bridge.kind}）${hint}` } }
        })
      }
      if (action === 'remove') {
        return mutate((db, meta) => {
          const b = findIt(db)
          if (!b) return { noSave: true, value: { text: '❌ 没有这个桥接（先 list 看 id）。' } }
          db.bridges = db.bridges.filter((x) => x.id !== b.id)
          return { value: { text: `${metaPrefix(meta)}已删掉桥接 ${b.name}（${b.id}），本地文件没删。` } }
        })
      }
      if (action === 'toggle') {
        return mutate((db, meta) => {
          const b = findIt(db)
          if (!b) return { noSave: true, value: { text: '❌ 没有这个桥接（先 list 看 id）。' } }
          b.enabled = typeof enabled === 'boolean' ? enabled : !b.enabled
          return { value: { text: `${metaPrefix(meta)}${b.name} 现在${b.enabled ? '启用' : '停用'}。` } }
        })
      }
      // test
      const snap = await read((db, meta) => ({ bridge: findIt(db), meta }))
      if (!snap.bridge) return { text: '❌ 没有这个桥接（先 list 看 id）。' }
      const r = await sendViaBridge({ bridge: snap.bridge, to: to || 'test', name: '测试', text: text || '这是一条桥接测试消息', kind: 'test' })
      return {
        text: `${metaPrefix(snap.meta)}${r.ok ? '✅ 测试消息已交给桥发送。' : `❌ 发送失败：${r.error}`}${
          snap.bridge.kind === 'file' ? `\n看 ${path.join(bridgeDir(snap.bridge.id), 'out.jsonl')}` : ''
        }`,
      }
    },
  }, 'fish-friends:bridge')

  register({
    name: 'friends_inbox',
    description:
      '把一条外来消息投进来（桥接轮询到消息也走同一条路）：陌生人先计数，满 N 次自动建档并建专属会话；熟人按路由规则进总台或专属会话。测试桥接时手动喂消息也用它。',
    parameters: {
      type: 'object',
      properties: {
        bridge: { type: 'string', description: '桥接 id 或名字' },
        uid: { type: 'string', description: '对方在这条桥上的 id' },
        name: { type: 'string', description: '对方昵称（可选）' },
        text: { type: 'string' },
        count: { type: 'number', description: '连投几条（测试自动建档用），默认 1，最多 10' },
        at: { type: 'number', description: '消息时间戳（可选）' },
      },
      required: ['bridge', 'uid', 'text'],
    },
    execute: async ({ bridge, uid, name, text, count = 1, at } = {}) => {
      const snap = await read((db, meta) => ({ db, meta, b: findBridge(db, bridge) }))
      const b = snap.b
      if (!b) return { text: `${metaPrefix(snap.meta)}❌ 没有叫「${bridge}」的桥接（先 friends_bridge list）。` }
      const n = Math.min(10, Math.max(1, Math.floor(Number(count) || 1)))
      const results = []
      for (let i = 0; i < n; i += 1) {
        const r = await ingestIncoming(ctx, {
          bridgeId: b.id,
          bridgeName: b.name,
          uid,
          name,
          text: i === 0 ? String(text) : `${text}（${i + 1}）`,
          at: Number(at) || Date.now(),
        })
        results.push(r)
        if (r && r.ok === false) break
      }
      const last = results[results.length - 1]
      if (last && last.ok === false) return { text: `❌ 没投进去：${last.error}` }
      const routeText = { shared: '总台会话', dedicated: '专属会话', held: '限流暂存', dropped: '没投出去', pending: '没投（没会话）' }
      const lines = results.map((r, i) => `#${i + 1} → ${routeText[r.route] || r.route}${r.note ? `（${r.note}）` : ''}`)
      return {
        text:
          `投了 ${results.length} 条：\n${lines.join('\n')}` +
          (last?.promoted ? `\n🎉 已自动建档「${last.friendName}」${last.sessionId ? `，专属会话 ${last.sessionId}` : ''}` : '') +
          (last?.note && last.route !== 'dedicated' ? `\n${last.note}` : ''),
      }
    },
  }, 'fish-friends:inbox')

  register({
    name: 'friends_send',
    description: '通过桥接给某个朋友发消息（出站）：会写进消息流和 TA 的互动记录；桥发不出去时留在 outbox 里重试。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        bridge: { type: 'string', description: '指定桥接 id/名字（可选，默认用 TA 的通道）' },
        kind: { type: 'string', description: 'reply / proactive / share，默认 reply' },
      },
      required: ['name', 'text'],
    },
    execute: async ({ name, text, bridge, kind = 'reply' } = {}) => {
      const snap = await read((db, meta) => {
        const r = resolve(db, name)
        return { db, meta, friend: r.friend, how: r.how, candidates: r.candidates.map((f) => f.name) }
      })
      if (!snap.friend) return { text: metaPrefix(snap.meta) + noMatchText(name, snap) }
      const r = await sendToFriend(ctx, snap.db, snap.friend, text, { bridgeId: bridge, kind })
      return {
        text: r.ok
          ? `${metaPrefix(snap.meta)}✅ 已通过「${snap.db.bridges?.find((b) => b.id === r.bridgeId)?.name || r.bridgeId}」发给 ${snap.friend.name}（to ${r.to}）。`
          : `${metaPrefix(snap.meta)}❌ 没发出去：${r.error}\n消息已进 outbox，桥恢复后会自动重试。`,
      }
    },
  }, 'fish-friends:send')

  register({
    name: 'friends_route',
    description:
      '设置消息路由：总台会话可以有多个（陌生人消息轮流进），自动建档阈值（默认 3 条），专属会话限流，以及「公共场合聊起来自动转私聊」。get 看现状；set 改；release 立刻补投被限流的消息。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'release'], description: '默认 get' },
        addShared: { type: 'boolean', description: '把 sharedRef 加为一个总台（可加多个）' },
        removeShared: { type: 'string', description: '删掉这个总台（ref 或 id）' },
        sharedRef: { type: 'string', description: '总台会话 id（session-…）；不带 addShared 时表示「只要这一个」' },
        sharedLabel: { type: 'string' },
        sharedKind: { type: 'string', description: 'dsh / url / platform，默认 dsh' },
        setGoal: { type: 'boolean', description: '配合 sharedRef：这个总台要不要参与交友目标提醒（false = 只接私聊，不接交友提醒）' },
        sharedGoal: { type: 'boolean', description: 'addShared 时该总台是否参与交友提醒，默认 true' },
        clearShared: { type: 'boolean', description: '清空所有总台' },
        promoteAfter: { type: 'number', description: '同一个人收到几条后自动建档，默认 3' },
        rateMax: { type: 'number', description: '专属会话窗口内最多收几条（默认 30）' },
        rateWindowMinutes: { type: 'number', description: '限流窗口分钟数（默认 60）' },
        workspaceDir: { type: 'string', description: '专属工作区根目录（空 = 默认 $DSH_HOME/fish-friends/workspaces）' },
        publicToPrivate: { type: 'boolean', description: '公共场合（总台）聊起来后自动转私聊并让机器人开场' },
        publicAfterMessages: { type: 'number', description: '聊够几条才邀请私聊，默认 2' },
        publicCooldownHours: { type: 'number', description: '同一个人两次私聊邀请的间隔小时数，默认 24' },
        opener: { type: 'string', description: '私聊开场提示（可选，写给机器人看的）' },
        clearPending: { type: 'boolean', description: '清空陌生人计数器' },
      },
    },
    execute: async ({
      action = 'get',
      addShared,
      removeShared,
      sharedRef,
      sharedLabel,
      sharedKind = 'dsh',
      setGoal,
      sharedGoal,
      clearShared,
      promoteAfter,
      rateMax,
      rateWindowMinutes,
      workspaceDir,
      publicToPrivate,
      publicAfterMessages,
      publicCooldownHours,
      opener,
      clearPending,
    } = {}) => {
      if (action === 'release') {
        const r = await releaseHolds(ctx)
        return { text: `限流补投：放出 ${r.released} 条，仍压着 ${r.kept} 条。` }
      }
      if (action === 'get') {
        return read((db, meta) => {
          const g = db.settings?.routing || {}
          const rate = db.settings?.rate || {}
          const p2p = g.publicToPrivate || {}
          const list = sharedList(db)
          const lines = [
            `总台会话（${list.length}）：`,
            ...(list.length
              ? list.map(
                  (s, i) =>
                    `  ${i + 1}. ${s.kind}:${s.ref}${s.label ? `（${s.label}）` : ''}${s.goal === false ? '｜不参与交友提醒' : '｜参与交友提醒'}${s.lastAt ? `｜最近接消息 ${new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false })}` : '｜还没接过'}`,
                )
              : ['  没设（陌生人消息只会被记下来）']),
            `自动建档阈值：${g.promoteAfter} 条`,
            `交友目标提醒：发给 ${list.filter((s) => s.goal !== false).length} 个总台${list.filter((s) => s.goal === false).length ? `（另有 ${list.filter((s) => s.goal === false).length} 个只接私聊、不接提醒）` : ''}`,
            `默认限流：${Math.round((rate.windowMs || 3600000) / 60000)} 分钟 / ${rate.max} 条`,
            `公共场合转私聊：${p2p.enabled ? `开（聊够 ${p2p.afterMessages} 条、冷却 ${Math.round((p2p.cooldownMs || 0) / 3600000)}h）` : '关'}`,
            `工作区根目录：${g.workspaceDir || workspaceRoot()}`,
            `陌生人计数（${(db.pendingSenders || []).length}）：${(db.pendingSenders || []).map((p) => `${p.name || p.uid} ${p.count}`).join(' / ') || '无'}`,
            `限流暂存：${(db.holds || []).length} 条`,
          ]
          return { text: metaPrefix(meta) + lines.join('\n') }
        })
      }
      // set
      return mutate((db, meta) => {
        db.settings = db.settings || {}
        const routing = { ...(db.settings.routing || {}) }
        const rate = { ...(db.settings.rate || {}) }
        let list = Array.isArray(routing.sharedSessions) ? routing.sharedSessions.slice() : []
        if (clearShared) list = []
        if (removeShared) {
          const key = norm(removeShared)
          list = list.filter((s) => norm(s.ref) !== key && norm(s.id) !== key)
        }
        if (sharedRef) {
          const key = norm(sharedRef)
          if (addShared) {
            if (!list.some((s) => norm(s.ref) === key)) {
              const made = newSharedSession({ ref: sharedRef, label: sharedLabel, kind: sharedKind, goal: sharedGoal !== false })
              if (made) list.push(made)
            }
          } else if (!removeShared && setGoal === undefined) {
            // 老用法：只给 sharedRef = 只要这一个总台
            const made = newSharedSession({ ref: sharedRef, label: sharedLabel, kind: sharedKind, goal: sharedGoal !== false })
            list = made ? [made] : []
          }
        }
        if (setGoal !== undefined) {
          const key = norm(sharedRef)
          list = list.map((s) => (norm(s.ref) === key || norm(s.id) === key ? { ...s, goal: setGoal === true } : s))
        }
        routing.sharedSessions = list.slice(-10)
        if (promoteAfter !== undefined) routing.promoteAfter = Math.min(20, Math.max(1, Math.floor(Number(promoteAfter) || 3)))
        if (workspaceDir !== undefined) routing.workspaceDir = String(workspaceDir || '')
        const p2p = { ...(routing.publicToPrivate || {}) }
        if (publicToPrivate !== undefined) p2p.enabled = publicToPrivate === true
        if (publicAfterMessages !== undefined) p2p.afterMessages = Math.min(20, Math.max(1, Math.floor(Number(publicAfterMessages) || 2)))
        if (publicCooldownHours !== undefined) p2p.cooldownMs = Math.min(7 * 24, Math.max(1, Number(publicCooldownHours) || 24)) * 3600000
        if (opener !== undefined) p2p.opener = String(opener || '').slice(0, 200)
        routing.publicToPrivate = p2p
        if (rateWindowMinutes !== undefined) rate.windowMs = Math.max(1, Number(rateWindowMinutes) || 60) * 60000
        if (rateMax !== undefined) rate.max = Math.max(1, Math.floor(Number(rateMax) || 30))
        db.settings.routing = routing
        db.settings.rate = rate
        if (clearPending) db.pendingSenders = []
        return {
          value: {
            text:
              `${metaPrefix(meta)}✅ 路由已更新：总台 ${routing.sharedSessions.length} 个` +
              `${routing.sharedSessions.length ? `（${routing.sharedSessions.map((s) => s.label || s.ref).join('、')}）` : ''}` +
              `｜阈值 ${routing.promoteAfter} 条｜默认限流 ${Math.round((rate.windowMs || 3600000) / 60000)} 分钟 / ${rate.max} 条` +
              `｜交友提醒 ${routing.sharedSessions.filter((s) => s.goal !== false).length}/${routing.sharedSessions.length} 个总台` +
              `｜公共场合转私聊 ${routing.publicToPrivate.enabled ? '开' : '关'}`,
          },
        }
      })
    },
  }, 'fish-friends:route')

  register({
    name: 'friends_proactive',
    description:
      '主动闲聊：机器人闲着时按时间段 + 亲密度决定频率去找朋友说话（只在 TA 有专属会话时）。get 看状态和下次时间；set 调开关/时段/频率/每天上限；now 立刻按当前规则跑一次。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'now', 'enableAll', 'disableAll'], description: '默认 get' },
        name: { type: 'string', description: '只改/只看这个朋友（可选）' },
        enabled: { type: 'boolean', description: '总闸（全局）或这个朋友的开关' },
        windowFrom: { type: 'number', description: '开始小时 0-23' },
        windowTo: { type: 'number', description: '结束小时 0-23（支持跨夜）' },
        dailyCap: { type: 'number', description: '每天最多主动几次（0=不主动）' },
        minGapHours: { type: 'number', description: '亲密度 100 时的间隔小时数' },
        maxGapHours: { type: 'number', description: '亲密度 0 时的间隔小时数' },
        mode: { type: 'string', enum: ['template', 'agent'], description: 'template=本地话术不花 token；agent=让专属会话自己想' },
        jitter: { type: 'number', description: '间隔抖动比例 0~0.9，默认 0.2' },
        force: { type: 'boolean', description: 'now 时无视时段限制' },
      },
    },
    execute: async ({ action = 'get', name, enabled, windowFrom, windowTo, dailyCap, minGapHours, maxGapHours, mode, jitter, force } = {}) => {
      if (action === 'enableAll' || action === 'disableAll') {
        const on = action === 'enableAll'
        return mutate((db, meta) => {
          for (const f of db.friends || []) f.proactive = { ...(f.proactive || {}), enabled: on }
          db.settings = db.settings || {}
          db.settings.proactive = { ...(db.settings.proactive || {}), enabled: on || db.settings.proactive?.enabled === true }
          return { value: { text: `${metaPrefix(meta)}${on ? '已给所有朋友打开主动闲聊（总闸也开了）' : '已关掉所有人的主动闲聊'}。` } }
        })
      }
      if (action === 'get') {
        return read((db, meta) => {
          const g = db.settings?.proactive || {}
          const lines = [
            `总闸：${g.enabled ? '开' : '关'}｜时段 ${g.windowFrom}:00-${g.windowTo}:00｜每天上限 ${g.dailyCap}｜模式 ${g.mode}｜抖动 ±${Math.round((g.jitter || 0) * 100)}%`,
            `间隔：亲密度 0 → ${Math.round((g.maxGapMs || 0) / 3600000)}h，亲密度 100 → ${Math.round((g.minGapMs || 0) / 3600000)}h`,
          ]
          if (name) {
            const r = resolve(db, name)
            if (!r.friend) return { text: metaPrefix(meta) + noMatchText(name, r) }
            const c = proactiveConfig(db, r.friend)
            lines.push(
              `${r.friend.name}：${c.enabled ? '会主动' : '不会主动'}｜亲密度 ${affinity(r.friend)}｜目标间隔 ${Math.round(targetGapMs(db, r.friend) / 3600000)}h（今天 ${proactiveSentToday(db, r.friend.id)}/${c.dailyCap}）`,
            )
          } else {
            const due = dueProactive(db)
            lines.push(`现在符合条件的人：${due.length ? due.map((x) => x.friend.name).join('、') : '无'}`)
            const preview = nextDuePreview(db)
            if (preview.length) {
              lines.push('下次大概：')
              for (const p of preview) {
                lines.push(`- ${p.name}｜亲密度 ${p.affinity}｜约 ${new Date(p.nextAt).toLocaleString('zh-CN', { hour12: false })}${p.withinWindow ? '' : '（在时段外，会顺延）'}`)
              }
            }
          }
          return { text: metaPrefix(meta) + lines.join('\n') }
        })
      }
      if (action === 'now') {
        const r = await tickProactive(ctx, { maxPerTick: 5 })
        const lines = r.sent.map((x) => `${x.ok ? '✅' : '❌'} ${x.name}${x.error ? `：${x.error}` : ''}`)
        return { text: r.checked ? `这次看了 ${r.checked} 个人：\n${lines.join('\n')}` : '现在没有人符合主动闲聊的条件（开关/时段/间隔/上限）。' }
      }
      // set
      return mutate((db, meta) => {
        db.settings = db.settings || {}
        const g = { ...(db.settings.proactive || {}) }
        if (enabled !== undefined) g.enabled = enabled === true
        if (windowFrom !== undefined) g.windowFrom = Math.min(23, Math.max(0, Math.floor(Number(windowFrom))))
        if (windowTo !== undefined) g.windowTo = Math.min(23, Math.max(0, Math.floor(Number(windowTo))))
        if (dailyCap !== undefined) g.dailyCap = Math.min(50, Math.max(0, Math.floor(Number(dailyCap))))
        if (minGapHours !== undefined) g.minGapMs = Math.max(5, Number(minGapHours) || 6) * 3600000
        if (maxGapHours !== undefined) g.maxGapMs = Math.max(5, Number(maxGapHours) || 72) * 3600000
        if (g.maxGapMs < g.minGapMs) g.maxGapMs = g.minGapMs
        if (mode) g.mode = ['template', 'agent'].includes(mode) ? mode : 'template'
        if (jitter !== undefined) g.jitter = Math.min(0.9, Math.max(0, Number(jitter) || 0))
        db.settings.proactive = g
        if (name) {
          const r = resolve(db, name)
          if (!r.friend) return { noSave: true, value: { text: metaPrefix(meta) + noMatchText(name, r) } }
          const f = r.friend
          const p = { ...(f.proactive || {}) }
          if (enabled !== undefined) p.enabled = enabled === true
          if (windowFrom !== undefined) p.windowFrom = g.windowFrom
          if (windowTo !== undefined) p.windowTo = g.windowTo
          if (dailyCap !== undefined) p.dailyCap = g.dailyCap
          if (mode) p.mode = g.mode
          f.proactive = p
          return { value: { text: `${metaPrefix(meta)}✅ ${f.name}：主动闲聊${p.enabled ? '开' : '关'}，每天 ${p.dailyCap ?? g.dailyCap} 条。` } }
        }
        return {
          value: {
            text: `${metaPrefix(meta)}✅ 主动闲聊：总闸${g.enabled ? '开' : '关'}，时段 ${g.windowFrom}:00-${g.windowTo}:00，每天 ${g.dailyCap} 条，间隔 ${Math.round(g.minGapMs / 3600000)}-${Math.round(g.maxGapMs / 3600000)}h，模式 ${g.mode}。`,
          },
        }
      })
    },
  }, 'fish-friends:proactive')

  register({
    name: 'friends_rhythm',
    description:
      '看朋友作息：用消息流统计 TA 常出没的时段（活跃小时、高峰、平均间隔），判断现在是不是 TA 通常在线的时间。给 name 看一个人；all:true 看所有聊过的人。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '朋友名字（可选）' },
        all: { type: 'boolean', description: '看所有人（按互动次数排序）' },
        days: { type: 'number', description: '统计最近多少天，默认 30' },
      },
    },
    execute: async ({ name, all, days } = {}) =>
      read((db, meta) => {
        const span = Math.min(365, Math.max(1, Math.floor(Number(days) || 30)))
        if (name) {
          const r = resolve(db, name)
          if (!r.friend) return { text: metaPrefix(meta) + noMatchText(name, r) }
          const a = analyzeRhythm(db, r.friend, { days: span })
          const next = nextActiveAt(a)
          const lines = [
            `「${r.friend.name}」的作息（近 ${span} 天，${a.total} 次互动）：`,
            a.text,
            `活跃时段：${hoursText(a.activeHours) || '还看不出来'}`,
            `高峰：${a.peakHour >= 0 ? `${String(a.peakHour).padStart(2, '0')}:00（${a.peakCount} 次）` : '无'}`,
            `平均间隔：${a.avgGapMs ? `约 ${Math.round(a.avgGapMs / 60000)} 分钟` : '样本太少'}`,
            `现在${activeNow(a) ? '通常在线' : '通常不在线'}${next ? `；下次可能在线 ${new Date(next).toLocaleString('zh-CN', { hour12: false })}` : ''}`,
          ]
          return { text: metaPrefix(meta) + lines.join('\n') }
        }
        const list = (db.friends || [])
          .map((f) => ({ f, a: analyzeRhythm(db, f, { days: span }) }))
          .filter((x) => x.a.total > 0)
          .sort((x, y) => y.a.total - x.a.total)
          .slice(0, 20)
        if (!list.length) return { text: metaPrefix(meta) + '还没有足够的消息，作息分析不出来。' }
        const lines = [
          `作息一览（近 ${span} 天）：`,
          ...list.map((x) => `- ${x.f.name}｜${x.a.total} 次｜${hoursText(x.a.activeHours)}${activeNow(x.a) ? '（现在通常在线）' : ''}`),
        ]
        return { text: metaPrefix(meta) + lines.join('\n') }
      }),
  }, 'fish-friends:rhythm')

  register({
    name: 'friends_goal',
    description:
      '交友目标：设置每天要认识几位新朋友的区间；开启后没达标会按间隔提醒各总台会话主动去聊。get 看今天进度；set 改开关/区间/提醒节奏；now 立刻提醒一次。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'now'], description: '默认 get' },
        enabled: { type: 'boolean', description: '开/关交友目标' },
        min: { type: 'number', description: '每天至少认识几位，默认 3' },
        max: { type: 'number', description: '每天最多算几位，默认 8' },
        remindEveryHours: { type: 'number', description: '没达标时每隔几小时提醒一次，默认 2' },
        dailyCap: { type: 'number', description: '一天最多提醒几次，默认 3' },
        force: { type: 'boolean', description: 'now 时忽略时段/间隔/上限' },
      },
    },
    execute: async ({ action = 'get', enabled, min, max, remindEveryHours, dailyCap, force } = {}) => {
      if (action === 'now') {
        const r = await tickGoal(ctx, { force: force !== false })
        if (r.skipped) return { text: `这次没提醒：${r.skipped}` }
        const lines = r.sent.map((x) => `${x.ok ? '✅' : '❌'} ${x.label}${x.error ? `：${x.error}` : ''}`)
        return { text: `已提醒 ${lines.filter((x) => x.startsWith('✅')).length}/${lines.length} 个总台：\n${lines.join('\n')}` }
      }
      if (action === 'get') {
        return read((db, meta) => {
          const st = goalStatus(db)
          const lines = [
            goalLine(st),
            `开关：${st.enabled ? '开' : '关'}｜区间 ${st.min}-${st.max} 位/天`,
            `提醒：没达标每隔 ${st.remindEveryMin} 分钟一次，每天最多 ${st.dailyCap} 次（${GOAL_ACTIVE_FROM}:00-${GOAL_ACTIVE_TO}:00 之外不提醒）`,
            `今天已提醒：${st.sentToday} 次${st.lastRemindAt ? `（上次 ${new Date(st.lastRemindAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}`,
            `总台：${st.sharedCount} 个｜今天认识的人：${st.todayNames.join('、') || '还没有'}`,
            `下次可提醒：${st.canRemind || !st.enabled || st.met ? '现在就可以' : st.nextRemindAt ? new Date(st.nextRemindAt).toLocaleString('zh-CN', { hour12: false }) : '等下次轮询'}`,
          ]
          return { text: metaPrefix(meta) + lines.join('\n') }
        })
      }
      // set
      return mutate((db, meta) => {
        db.settings = db.settings || {}
        const g = { ...(db.settings.goal || {}) }
        if (enabled !== undefined) g.enabled = enabled === true
        if (min !== undefined) g.min = Math.min(50, Math.max(0, Math.floor(Number(min) || 0)))
        if (max !== undefined) g.max = Math.min(50, Math.max(0, Math.floor(Number(max) || 0)))
        if (g.max < g.min) g.max = g.min
        if (remindEveryHours !== undefined) g.remindEveryMs = Math.min(24, Math.max(0.25, Number(remindEveryHours) || 2)) * 3600000
        if (dailyCap !== undefined) g.dailyCap = Math.min(20, Math.max(0, Math.floor(Number(dailyCap) || 0)))
        db.settings.goal = g
        const st = goalStatus(db)
        return {
          value: {
            text: `${metaPrefix(meta)}✅ 交友目标：${g.enabled ? '开' : '关'}，每天 ${g.min}${g.max > g.min ? `~${g.max}` : ''} 位，没达标每 ${Math.round((g.remindEveryMs || 0) / 60000)} 分钟提醒一次（每天最多 ${g.dailyCap} 次）。今天已认识 ${st.today} 位。`,
          },
        }
      })
    },
  }, 'fish-friends:goal')

  register({
    name: 'friends_private',
    description:
      '把和某个朋友的聊天转到私聊：确保 TA 有专属会话，并让那个会话里的机器人用 friends_send 开口（公共场合聊起来时也会自动做，这里用于手动补一次）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '朋友名字' },
        text: { type: 'string', description: '刚才聊到的内容（可选，帮机器人接话）' },
      },
      required: ['name'],
    },
    execute: async ({ name, text } = {}) => {
      const snap = await read((db) => {
        const r = resolve(db, name)
        return { friend: r.friend, how: r.how, candidates: r.candidates.map((f) => f.name) }
      })
      if (!snap.friend) {
        return { text: snap.candidates.length ? `匹配到多个人：${snap.candidates.join('、')}，说得更具体一点。` : `鱼友簿里没有「${name}」。` }
      }
      const r = await inviteToPrivate(ctx, { friend: snap.friend, reason: 'manual', lastText: text || '' })
      return {
        text: r.ok
          ? `✅ 已让「${snap.friend.name}」的专属会话主动开口（${r.sessionId}）${r.created ? '，会话是刚建的' : ''}；面板会自动切到那个会话。`
          : `❌ 没能转私聊：${r.error}`,
      }
    },
  }, 'fish-friends:private')

  register({
    name: 'friends_merge',
    description:
      '合并两份档案（同一个人用了不同联系方式 / 曾经被重复建档）：通道、别名、爱好、互动记录合一，消息记录指到保留的那份，然后删掉多余档案。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '要并掉的档案（名字/id/别名）' },
        into: { type: 'string', description: '保留哪一份（名字/id/别名）' },
        dryRun: { type: 'boolean', description: '只预览结果，不动数据' },
      },
      required: ['from', 'into'],
    },
    execute: async ({ from, into, dryRun } = {}) =>
      mutate((db, meta) => {
        const a = resolve(db, from)
        const b = resolve(db, into)
        if (!a.friend) return { noSave: true, value: { text: metaPrefix(meta) + (a.candidates.length ? `「${from}」匹配到多个人：${a.candidates.map((f) => f.name).join('、')}` : `找不到「${from}」`) } }
        if (!b.friend) return { noSave: true, value: { text: metaPrefix(meta) + (b.candidates.length ? `「${into}」匹配到多个人：${b.candidates.map((f) => f.name).join('、')}` : `找不到「${into}」`) } }
        const src = a.friend
        const dst = b.friend
        if (src.id === dst.id) return { noSave: true, value: { text: `${metaPrefix(meta)}这两个是同一份档案（${src.name}），不用合并。` } }
        const chKey = (c) => `${norm(c.platform)}:${norm(c.uid)}`
        const seen = new Set((dst.channels || []).map(chKey))
        let addedCh = 0
        for (const c of src.channels || []) {
          if (!c || !str(c.platform)) continue
          const k = chKey(c)
          if (seen.has(k)) continue
          seen.add(k)
          dst.channels = dst.channels || []
          dst.channels.push(c)
          addedCh += 1
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
        const log = [...(dst.log || []), ...(src.log || [])].filter((l) => l && l.at).sort((x, y) => x.at - y.at)
        dst.log = log.slice(-80)
        if (!dst.session?.ref && src.session?.ref) dst.session = src.session
        if (!dst.briefed?.sessionRef && src.briefed?.sessionRef) dst.briefed = src.briefed
        dst.createdAt = Math.min(Number(dst.createdAt) || Infinity, Number(src.createdAt) || Infinity) || Date.now()
        dst.lastTalkAt = Math.max(Number(dst.lastTalkAt) || 0, Number(src.lastTalkAt) || 0)
        dst.lastPrivateInviteAt = Math.max(Number(dst.lastPrivateInviteAt) || 0, Number(src.lastPrivateInviteAt) || 0)
        dst.autoCreated = dst.autoCreated === true || src.autoCreated === true
        dst.sourceBridge = dst.sourceBridge || src.sourceBridge || ''
        let moved = 0
        for (const m of db.messages || []) if (m && m.friendId === src.id) { m.friendId = dst.id; moved += 1 }
        for (const h of db.holds || []) if (h && h.friendId === src.id) { h.friendId = dst.id; h.friendName = dst.name }
        const srcKeys = new Set((src.channels || []).map((c) => `${str(c.platform)}:${str(c.uid)}`))
        db.pendingSenders = (db.pendingSenders || []).filter((p) => !srcKeys.has(`${p.bridgeId}:${p.uid}`))
        db.friends = (db.friends || []).filter((f) => f.id !== src.id)
        const summary = `✅ 已把「${src.name}」并进「${dst.name}」：+${addedCh} 个通道，${moved} 条消息指过来，别名 ${(dst.aliases || []).length} 个，爱好 ${(dst.interests || []).length} 个。`
        if (dryRun) return { noSave: true, value: { text: `${metaPrefix(meta)}（预览，未保存）${summary}` } }
        return { value: { text: metaPrefix(meta) + summary } }
      }),
  }, 'fish-friends:merge')
}
