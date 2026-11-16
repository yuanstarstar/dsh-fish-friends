// 鱼友簿 · 设置页面板 + 激活浮层。
// 面板：朋友圈（亲密度/爱好/会话状态/最近互动）+「这条内容发给谁」。
// 浮层：轮询 /pending，把 host 排队的「切到某人的会话」变成真正的 UI 跳转。
window.__ModuleLoader__.load({
  id: '@local/dsh-fish-friends',
  factory(require) {
    const React = require('react')
    const { useEffect, useState, useCallback } = React
    const h = React.createElement

    const API = '/dsh-fish-friends/api'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
      warn: 'var(--dsw-alias-state-warning-primary, #ffc53d)',
    }

    const S = {
      // 面板根节点自己滚动：main 插槽给的是整块高度，朋友一多必须能滚，否则下面全被裁掉
      wrap: {
        color: C.text,
        fontSize: '12px',
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        paddingRight: '4px',
        paddingBottom: '28px',
        overscrollBehavior: 'contain',
      },
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', background: C.bg, marginBottom: '12px' },
      title: { fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '8px', display: 'flex', gap: '8px', alignItems: 'center' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '7px 9px', fontSize: '12px', outline: 'none', width: '100%', boxSizing: 'border-box' },
      small: { color: C.faint, fontSize: '11px', lineHeight: 1.7 },
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '5px 9px', fontSize: '11px', cursor: 'pointer' },
      primary: { border: `1px solid ${C.accent}`, background: C.accent, color: '#08111f', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '10px' },
      buddy: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '10px 12px', background: C.bg, display: 'flex', flexDirection: 'column', gap: '6px' },
      name: { fontSize: '13px', fontWeight: 700, color: C.text },
      badge: { fontSize: '10px', border: `1px solid ${C.border}`, borderRadius: '999px', padding: '1px 7px', color: C.sub },
      chip: { fontSize: '10px', background: 'rgba(255,255,255,.06)', borderRadius: '4px', padding: '1px 6px', color: C.sub },
      barOuter: { height: '4px', background: 'rgba(255,255,255,.10)', borderRadius: '999px', overflow: 'hidden' },
      barInner: (v) => ({ height: '100%', width: `${v}%`, background: v >= 70 ? C.ok : v >= 40 ? C.warn : C.danger }),
      toast: {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: 9999,
        background: 'rgba(20,20,28,.94)', color: C.text, border: `1px solid ${C.border}`,
        borderRadius: '8px', padding: '8px 12px', fontSize: '12px', pointerEvents: 'none',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
      },
      pick: { borderTop: `1px dashed ${C.border}`, paddingTop: '8px', marginTop: '8px' },
    }

    async function api(path, options = {}) {
      const init = { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, cache: 'no-store' }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch {
        throw new Error('连不上鱼友簿后端：插件可能还没重启加载')
      }
      const raw = await response.text().catch(() => '')
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        throw new Error(`后端返回的不是 JSON：${raw.slice(0, 120)}`)
      }
      if (!data?.ok) throw new Error(data?.error || `请求失败 ${response.status}`)
      return data
    }

    const toList = (text) => String(text || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
    const dayText = (d) => (d === null || d === undefined ? '还没说过话' : d === 0 ? '今天说过' : `${d} 天没说话`)
    const sessionLabel = (s) => {
      if (!s || !s.bound) return '未绑定会话'
      if (s.kind === 'url') return '网页会话'
      if (s.exists === false) return s.lookupError ? '会话找不到' : '会话找不到'
      const bits = [s.kind === 'dsh' ? 'DSH 会话' : s.kind]
      if (s.title) bits.push(s.title)
      else if (s.label) bits.push(s.label)
      if (s.running) bits.push('在跑')
      return bits.join('·')
    }

    function Buddy({ f, onOpen, onNote, onShare }) {
      const [open, setOpen] = useState(false)
      return h('div', { style: S.buddy },
        h('div', { style: S.row },
          h('span', { style: S.name }, f.name),
          f.needsName ? h('span', { style: { ...S.chip, color: C.warn } }, '待补名字') : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.badge }, `亲密 ${f.affinity}`),
        ),
        h('div', { style: S.barOuter }, h('div', { style: S.barInner(f.affinity) })),
        h('div', { style: S.small }, dayText(f.daysSince) + (f.channelText ? `｜${f.channelText}` : '')),
        f.rhythm && f.rhythm.total
          ? h('div', { style: { ...S.small, color: C.accent } }, f.rhythm.line || `常出没 ${(f.rhythm.activeHours || []).join('、')} 点`)
          : null,
        (f.interests || []).length
          ? h('div', { style: S.row }, (f.interests || []).slice(0, 5).map((i) => h('span', { key: i, style: S.chip }, i)))
          : h('div', { style: S.small }, '还没记爱好'),
        h('div', { style: { ...S.small, color: f.session?.bound ? (f.session.exists === false ? C.danger : C.sub) : C.faint } },
          sessionLabel(f.session),
        ),
        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: () => onOpen(f) }, '打开会话'),
          h('button', { style: S.btn, onClick: () => onNote(f) }, '记一笔'),
          h('button', { style: S.btn, onClick: () => onShare(f) }, '标记已发'),
          h('button', { style: S.btn, onClick: () => setOpen(!open) }, open ? '收起' : '最近'),
        ),
        open
          ? h('div', { style: S.small },
              (f.log || []).length
                ? f.log.map((l, i) => h('div', { key: i },
                    `${new Date(l.at).toLocaleDateString('zh-CN')} `,
                    l.kind === 'share' ? (l.sent ? '［分享·已发］' : '［分享·待发］') : '［聊过］',
                    l.text, l.mood ? `（${l.mood}）` : ''))
                : '还没记过互动')
          : null,
      )
    }

    const fmtTime = (at) => {
      if (!at) return ''
      const d = new Date(at)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    const ROUTE_LABEL = { shared: '总台', dedicated: '专属', invited: '转私聊', held: '限流暂存', dropped: '没投出', pending: '待会话', out: '我发出' }

    /** v0.4：桥接列表 + 新建（file 桥会给出收件目录）。 */
    function BridgesSection({ graph, onChanged, say }) {
      const [name, setName] = useState('')
      const [kind, setKind] = useState('file')
      const bridges = graph.bridges || []
      const runtime = graph.bridgeRuntime || {}

      async function add() {
        try {
          const res = await api('/bridge', { method: 'POST', body: { action: 'add', name: name.trim() || undefined, kind } })
          const dir = res.data && res.data.dir
          say(dir ? `建好了，收件目录：${dir}` : '建好了')
          setName('')
          onChanged()
        } catch (e) {
          say(`没建成：${e instanceof Error ? e.message : e}`)
        }
      }

      async function toggle(b) {
        try {
          await api('/bridge', { method: 'POST', body: { action: 'toggle', id: b.id, enabled: !b.enabled } })
          onChanged()
        } catch (e) {
          say(`没改成：${e instanceof Error ? e.message : e}`)
        }
      }

      return h('div', { style: S.card },
        h('div', { style: S.title },
          '桥接',
          h('span', { style: S.badge }, `${bridges.length} 个`),
          runtime.running ? h('span', { style: { ...S.badge, color: C.ok } }, '轮询中') : h('span', { style: { ...S.badge, color: C.warn } }, '未启动'),
        ),
        bridges.length
          ? bridges.map((b) => h('div', { key: b.id, style: S.pick },
              h('div', { style: S.row },
                h('span', { style: S.name }, b.name),
                h('span', { style: S.badge }, b.kind),
                h('span', { style: { ...S.badge, color: b.enabled ? C.ok : C.faint } }, b.enabled ? '启用' : '停用'),
                h('span', { style: { flex: 1 } }),
                h('button', { style: S.btn, onClick: () => toggle(b) }, b.enabled ? '停用' : '启用'),
              ),
              h('div', { style: S.small }, `收 ${b.stats.in}｜发 ${b.stats.out}｜建档 ${b.stats.promoted}｜错 ${b.stats.errors}`),
              b.dir ? h('div', { style: S.small }, `收件：${b.dir}`) : null,
              b.sendUrl ? h('div', { style: S.small }, `发送：${b.sendUrl}`) : null,
            ))
          : h('div', { style: S.small }, '还没有桥接。建一个 file 桥，任何脚本往它的 in.jsonl 写一行就能把消息送进来。'),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('input', { style: { ...S.input, flex: 1, width: 'auto' }, placeholder: '桥接名字，例如 QQ / 贴吧', value: name, onChange: (e) => setName(e.target.value) }),
          h('select', { style: { ...S.input, width: 'auto' }, value: kind, onChange: (e) => setKind(e.target.value) },
            h('option', { value: 'file' }, 'file（文件收件）'),
            h('option', { value: 'http' }, 'http（转发 URL）'),
            h('option', { value: 'mock' }, 'mock（自测用）'),
          ),
          h('button', { style: S.primary, onClick: add }, '建桥'),
        ),
        (runtime.errors || []).length
          ? h('div', { style: { ...S.small, color: C.warn } }, `最近错误：${(runtime.errors[runtime.errors.length - 1] || {}).text || '未知错误'}`)
          : null,
      )
    }

    /** v0.5：多个总台（轮流接）、建档阈值、专属会话限流、公共场合转私聊、待建档的陌生人。 */
    function RoutingSection({ graph, onChanged, say }) {
      const routing = graph.routing || {}
      const rate = graph.rate || {}
      const shareds = graph.sharedSessions || []
      const p2p = routing.publicToPrivate || {}
      const [sharedRef, setSharedRef] = useState('')
      const [label, setLabel] = useState('')
      const [promoteAfter, setPromoteAfter] = useState(String(routing.promoteAfter || 3))
      const [rateMinutes, setRateMinutes] = useState(String(Math.round((Number(rate.windowMs) || 3600000) / 60000)))
      const [rateMax, setRateMax] = useState(String(rate.max || 30))
      const [p2pOn, setP2pOn] = useState(p2p.enabled === true)
      const [after, setAfter] = useState(String(p2p.afterMessages || 2))
      const [cooldown, setCooldown] = useState(String(Math.round((Number(p2p.cooldownMs) || 86400000) / 3600000)))
      const [opener, setOpener] = useState(p2p.opener || '')
      const pendingSenders = graph.pendingSenders || []

      async function save(patch) {
        try {
          await api('/routing', { method: 'POST', body: patch })
          say('已保存')
          onChanged()
        } catch (e) {
          say(`没存上：${e instanceof Error ? e.message : e}`)
        }
      }

      async function promote(p) {
        const ok = window.confirm(`现在就给「${p.name}」建档、建专属会话？`)
        if (!ok) return
        try {
          const res = await api('/routing', { method: 'POST', body: { promote: true, bridgeId: p.bridgeId, uid: p.uid, name: p.name } })
          const d = res.data || {}
          say(d.sessionId ? `建好了：${d.friendName}（专属会话 ${d.sessionId}）` : `建好了：${d.friendName || p.name}`)
          onChanged()
        } catch (e) {
          say(`没建成：${e instanceof Error ? e.message : e}`)
        }
      }

      return h('div', { style: S.card },
        h('div', { style: S.title }, '消息怎么分', h('span', { style: S.badge }, `总台 ${shareds.length}`), graph.holds ? h('span', { style: { ...S.badge, color: C.warn } }, `限流暂存 ${graph.holds}`) : null),
        h('div', { style: S.small },
          shareds.length
            ? '陌生人/没绑专属会话的人，消息轮流投给最久没接的那个总台。'
            : '还没设总台会话：陌生人消息只会记进「待建档」，不会投进任何会话。',
        ),
        shareds.map((s) => h('div', { key: s.id || s.ref, style: { ...S.row, marginTop: '6px' } },
          h('span', { style: S.badge }, s.kind || 'dsh'),
          h('span', { style: S.small }, `${s.label || s.ref}${s.lastAt ? `｜上次接 ${fmtTime(s.lastAt)}` : '｜还没接过'}`),
          h('label', { style: { ...S.small, display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: s.goal !== false,
              onChange: (e) => save({ setGoal: true, sharedRef: s.ref, sharedGoal: e.target.checked }),
            }),
            '交友提醒',
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: () => save({ removeShared: s.id || s.ref }) }, '移除'),
        )),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('input', { style: { ...S.input, flex: 1, width: 'auto' }, placeholder: '再加一个总台会话 id（session-…）', value: sharedRef, onChange: (e) => setSharedRef(e.target.value) }),
          h('input', { style: { ...S.input, flex: 1, width: 'auto' }, placeholder: '备注名（可空）', value: label, onChange: (e) => setLabel(e.target.value) }),
          h('button', { style: S.primary, onClick: () => { const r = sharedRef.trim(); if (!r) return say('先填会话 id'); save({ addShared: true, sharedRef: r, sharedLabel: label.trim() }); setSharedRef(''); setLabel('') } }, '加总台'),
        ),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('span', { style: S.small }, '同一个人第'),
          h('input', { style: { ...S.input, width: '64px' }, value: promoteAfter, onChange: (e) => setPromoteAfter(e.target.value) }),
          h('span', { style: S.small }, '条消息开始建档；专属会话'),
          h('input', { style: { ...S.input, width: '64px' }, value: rateMinutes, onChange: (e) => setRateMinutes(e.target.value) }),
          h('span', { style: S.small }, '分钟内最多'),
          h('input', { style: { ...S.input, width: '64px' }, value: rateMax, onChange: (e) => setRateMax(e.target.value) }),
          h('span', { style: S.small }, '条'),
          h('button', { style: S.btn, onClick: () => save({ promoteAfter: Number(promoteAfter), rateWindowMinutes: Number(rateMinutes), rateMax: Number(rateMax) }) }, '保存'),
        ),
        h('div', { style: { ...S.row, marginTop: '10px' } },
          h('label', { style: { ...S.small, display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: p2pOn, onChange: (e) => setP2pOn(e.target.checked) }),
            '公共场合聊熟了就自动转私聊',
          ),
          h('span', { style: S.small }, '聊够'),
          h('input', { style: { ...S.input, width: '56px' }, value: after, onChange: (e) => setAfter(e.target.value) }),
          h('span', { style: S.small }, '条，且隔'),
          h('input', { style: { ...S.input, width: '64px' }, value: cooldown, onChange: (e) => setCooldown(e.target.value) }),
          h('span', { style: S.small }, '小时才再邀请'),
          h('button', { style: S.btn, onClick: () => save({ publicToPrivate: p2pOn, publicAfterMessages: Number(after), publicCooldownHours: Number(cooldown), opener: opener.trim() }) }, '保存'),
        ),
        h('div', { style: { ...S.row, marginTop: '6px' } },
          h('input', { style: { ...S.input, flex: 1, width: 'auto' }, placeholder: '私聊开场提示（可空，空则让专属会话自己看着说）', value: opener, onChange: (e) => setOpener(e.target.value) }),
        ),
        pendingSenders.length
          ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { ...S.small, color: C.warn } }, '待建档的陌生人（再收到就自动建档）：'),
              pendingSenders.map((p) => h('div', { key: `${p.bridgeId}:${p.uid}`, style: S.row },
                h('span', { style: S.small }, `${p.name || p.uid}｜${p.count}/${p.threshold} 条｜${fmtTime(p.lastAt)}`),
                h('span', { style: { flex: 1 } }),
                h('button', { style: S.btn, onClick: () => promote(p) }, '现在就建档'),
              )))
          : null,
      )
    }

    /** v0.4：消息流（进站+出站，含路由结果）。 */
    function MessagesSection({ graph, onChanged, say }) {
      const messages = graph.messages || []
      return h('div', { style: S.card },
        h('div', { style: S.title }, '消息流', h('span', { style: S.badge }, `最近 ${messages.length} 条`)),
        messages.length
          ? messages.map((m) => h('div', { key: m.id, style: { padding: '4px 0', borderTop: `1px solid ${C.border}` } },
              h('div', { style: S.row },
                h('span', { style: { ...S.badge, color: m.dir === 'in' ? C.accent : C.ok } }, m.dir === 'in' ? '收到' : '发出'),
                h('span', { style: S.badge }, ROUTE_LABEL[m.route] || m.route || '—'),
                h('span', { style: S.small }, m.friendName || m.name || m.bridgeName || ''),
                h('span', { style: { flex: 1 } }),
                h('span', { style: S.small }, fmtTime(m.at)),
              ),
              h('div', { style: { ...S.small, color: C.sub } }, String(m.text || '').slice(0, 200)),
            ))
          : h('div', { style: S.small }, '还没有消息。桥接收到第一条后会出现在这里。'),
        messages.length
          ? h('div', { style: { ...S.row, marginTop: '8px' } },
              h('button', { style: S.btn, onClick: async () => { try { const r = await api('/release', { method: 'POST', body: {} }); say(`补投 ${r.data?.released ?? 0} 条，仍压着 ${r.data?.kept ?? 0} 条`); onChanged() } catch (e) { say(String(e.message || e)) } } }, '此刻补投限流暂存'),
            )
          : null,
      )
    }

    /** v0.4：主动闲聊（时段/间隔/每日上限/模板 or 让专属会话自己说）。 */
    function ProactiveSection({ graph, onChanged, say }) {
      const cfg = (graph.proactive && graph.proactive.config) || {}
      const preview = (graph.proactive && graph.proactive.preview) || []
      const sentToday = (graph.proactive && graph.proactive.sentToday) || 0
      const [enabled, setEnabled] = useState(cfg.enabled === true)
      const [from, setFrom] = useState(String(cfg.windowFrom ?? 9))
      const [to, setTo] = useState(String(cfg.windowTo ?? 23))
      const [minGap, setMinGap] = useState(String(Math.round((Number(cfg.minGapMs) || 21600000) / 3600000)))
      const [maxGap, setMaxGap] = useState(String(Math.round((Number(cfg.maxGapMs) || 259200000) / 3600000)))
      const [dailyCap, setDailyCap] = useState(String(cfg.dailyCap ?? 2))
      const [mode, setMode] = useState(cfg.mode || 'template')

      async function save() {
        try {
          await api('/proactive', { method: 'POST', body: { enabled, windowFrom: Number(from), windowTo: Number(to), minGapHours: Number(minGap), maxGapHours: Number(maxGap), dailyCap: Number(dailyCap), mode } })
          say('已保存')
          onChanged()
        } catch (e) {
          say(`没存上：${e instanceof Error ? e.message : e}`)
        }
      }

      async function now() {
        try {
          const res = await api('/proactive', { method: 'POST', body: { action: 'now' } })
          const sent = (res.data && res.data.sent) || []
          say(sent.length ? `找了 ${sent.map((s) => s.name).join('、')}` : '这会儿还没到找谁的时候')
          onChanged()
        } catch (e) {
          say(`没发成：${e instanceof Error ? e.message : e}`)
        }
      }

      return h('div', { style: S.card },
        h('div', { style: S.title }, '主动闲聊', h('span', { style: { ...S.badge, color: enabled ? C.ok : C.faint } }, enabled ? '开着' : '关着'), h('span', { style: S.badge }, `今天已找 ${sentToday} 次`)),
        h('div', { style: S.row },
          h('label', { style: S.small }, h('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked) }), ' 闲着时主动找'),
          h('span', { style: S.small }, '时段'),
          h('input', { style: { ...S.input, width: '56px' }, value: from, onChange: (e) => setFrom(e.target.value) }),
          h('span', { style: S.small }, '点到'),
          h('input', { style: { ...S.input, width: '56px' }, value: to, onChange: (e) => setTo(e.target.value) }),
          h('span', { style: S.small }, '点'),
        ),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('span', { style: S.small }, '间隔'),
          h('input', { style: { ...S.input, width: '56px' }, value: minGap, onChange: (e) => setMinGap(e.target.value) }),
          h('span', { style: S.small }, '~'),
          h('input', { style: { ...S.input, width: '56px' }, value: maxGap, onChange: (e) => setMaxGap(e.target.value) }),
          h('span', { style: S.small }, '小时（亲密度越高越短）；每天最多'),
          h('input', { style: { ...S.input, width: '48px' }, value: dailyCap, onChange: (e) => setDailyCap(e.target.value) }),
          h('span', { style: S.small }, '次'),
        ),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('select', { style: { ...S.input, width: 'auto' }, value: mode, onChange: (e) => setMode(e.target.value) },
            h('option', { value: 'template' }, '模板（不花 token）'),
            h('option', { value: 'agent' }, '让专属会话自己想一句'),
          ),
          h('button', { style: S.primary, onClick: save }, '保存'),
          h('button', { style: S.btn, onClick: now }, '现在试一次'),
        ),
        preview.length
          ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: S.small }, '接下来大概什么时候找谁：'),
              preview.map((p) => h('div', { key: p.id, style: S.small }, `${p.name}：间隔约 ${p.gapHours} 小时，下次 ${fmtTime(p.nextAt)}${p.withinWindow === false ? '（在时段外）' : ''}${p.sentToday >= p.dailyCap ? '（今天到顶）' : ''}`)),
            )
          : null,
      )
    }

    /** v0.5：交友目标——每天要认识几位新朋友，没达标就主动提醒各个总台。 */
    function GoalSection({ graph, onChanged, say }) {
      const goal = (graph.goal && graph.goal.status) || {}
      const [enabled, setEnabled] = useState(goal.enabled === true)
      const [min, setMin] = useState(String(goal.min ?? 3))
      const [max, setMax] = useState(String(goal.max ?? 8))
      const [every, setEvery] = useState(String(Math.round(((Number(goal.remindEveryMin) || 120) / 60) * 10) / 10))
      const [cap, setCap] = useState(String(goal.dailyCap ?? 3))

      async function save() {
        try {
          await api('/goal', { method: 'POST', body: { action: 'set', enabled, min: Number(min), max: Number(max), remindEveryHours: Number(every), dailyCap: Number(cap) } })
          say('已保存')
          onChanged()
        } catch (e) {
          say(`没存上：${e instanceof Error ? e.message : e}`)
        }
      }

      async function remindNow() {
        try {
          const res = await api('/goal', { method: 'POST', body: { action: 'now', force: true } })
          const d = res.data || {}
          const sent = d.sent || []
          say(sent.length ? `提醒了 ${sent.filter((x) => x.ok).length}/${sent.length} 个总台` : `这次没提醒（${d.skip || '不在条件内'}）`)
          onChanged()
        } catch (e) {
          say(`没提醒上：${e instanceof Error ? e.message : e}`)
        }
      }

      return h('div', { style: S.card },
        h('div', { style: S.title },
          '交友目标',
          h('span', { style: { ...S.badge, color: goal.met ? C.ok : C.warn } }, `今天 ${goal.today ?? 0} 位 / 目标 ${goal.min ?? '-'}~${goal.max ?? '-'}`),
          goal.sentToday ? h('span', { style: S.badge }, `今天提醒 ${goal.sentToday}/${goal.dailyCap ?? '-'}`) : null,
        ),
        h('div', { style: S.small }, graph.goal?.line || '还没开。开了之后每天没达标，会主动提醒各个总台去认识新人。'),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('label', { style: { ...S.small, display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
            '开启',
          ),
          h('span', { style: S.small }, '每天认识'),
          h('input', { style: { ...S.input, width: '56px' }, value: min, onChange: (e) => setMin(e.target.value) }),
          h('span', { style: S.small }, '~'),
          h('input', { style: { ...S.input, width: '56px' }, value: max, onChange: (e) => setMax(e.target.value) }),
          h('span', { style: S.small }, '位；每'),
          h('input', { style: { ...S.input, width: '56px' }, value: every, onChange: (e) => setEvery(e.target.value) }),
          h('span', { style: S.small }, '小时提醒一次，每天最多'),
          h('input', { style: { ...S.input, width: '56px' }, value: cap, onChange: (e) => setCap(e.target.value) }),
          h('span', { style: S.small }, '次'),
        ),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('button', { style: S.btn, onClick: save }, '保存'),
          h('button', { style: S.btn, onClick: remindNow }, '现在就提醒一次'),
          goal.quiet ? h('span', { style: S.small }, `休息时段（${goal.quietFrom}:00–${goal.quietTo}:00 不提醒）`) : null,
          goal.nextRemindAt ? h('span', { style: S.small }, `下次可提醒：${fmtTime(goal.nextRemindAt)}`) : null,
          h('span', { style: S.small }, goal.sharedCount ? `${goal.sharedCount} 个总台参与提醒${goal.sharedAll > goal.sharedCount ? `（共 ${goal.sharedAll} 个）` : ''}` : '没有参与提醒的总台，提醒发不出去'),
        ),
      )
    }

    function FishFriendsPage(props) {
      const [graph, setGraph] = useState(null)
      const [error, setError] = useState('')
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [text, setText] = useState('')
      const [tags, setTags] = useState('')
      const [picks, setPicks] = useState(null)
      const [forError, setForError] = useState('')
      const [toast, setToast] = useState('')

      const say = (msg) => {
        setToast(msg)
        setTimeout(() => setToast(''), 3000)
      }

      const load = useCallback(async () => {
        try {
          const res = await api('/graph')
          setGraph(res.data)
          setError('')
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])

      async function doSearch() {
        const key = q.trim()
        if (!key) {
          setHits(null)
          return
        }
        try {
          const res = await api(`/search?q=${encodeURIComponent(key)}`)
          setHits(res.data.hits)
        } catch (e) {
          setHits([])
          setError(e instanceof Error ? e.message : String(e))
        }
      }

      async function doFor() {
        const value = text.trim()
        if (!value) {
          setForError('先说说这条内容是什么')
          return
        }
        try {
          const res = await api('/for', { method: 'POST', body: { text: value, tags: toList(tags), limit: 3 } })
          setPicks(res.data)
          setForError('')
        } catch (e) {
          setPicks(null)
          setForError(e instanceof Error ? e.message : String(e))
        }
      }

      async function activate(f, message) {
        try {
          const res = await api('/activate', { method: 'POST', body: { name: f.name, ...(message ? { message } : {}), note: '面板操作' } })
          const d = res.data || {}
          if (d.kind === 'url' && d.url) {
            try {
              window.open(d.url, '_blank', 'noopener')
            } catch {
              /* 打不开就把地址留给用户 */
            }
          }
          say(d.message?.sent ? `已投消息给 ${f.name}，并请求切会话` : `已请求切到 ${f.name} 的会话`)
        } catch (e) {
          say(`激活失败：${e instanceof Error ? e.message : e}`)
        }
      }

      async function note(f) {
        const value = window.prompt(`记一笔：和「${f.name}」聊了什么？`)
        if (!value || !value.trim()) return
        try {
          await api('/note', { method: 'POST', body: { name: f.name, text: value.trim() } })
          say('记好了')
          load()
        } catch (e) {
          say(`没记上：${e instanceof Error ? e.message : e}`)
        }
      }

      async function markSent(f) {
        const value = window.prompt(`标记已发给「${f.name}」的内容（留空就记一条空的）`, '')
        if (value === null) return
        try {
          await api('/share', { method: 'POST', body: { name: f.name, text: value.trim() || '（已发，未记内容）', sent: true } })
          say('已标记')
          load()
        } catch (e) {
          say(`没记上：${e instanceof Error ? e.message : e}`)
        }
      }

      if (!graph) {
        return h('div', { style: S.wrap },
          h('div', { style: S.card },
            h('div', { style: S.title }, '鱼友簿'),
            error ? h('div', { style: { color: C.danger, fontSize: '12px' } }, error) : h('div', { style: S.small }, '正在读取…'),
          ),
          toast ? h('div', { style: S.toast }, toast) : null,
        )
      }

      const meta = graph.meta || {}
      const host = graph.host || {}
      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.title },
            '鱼友簿',
            h('span', { style: S.badge }, `${graph.total} 位朋友`),
            h('span', { style: S.badge }, `${(graph.bridges || []).length} 个桥接`),
            h('span', { style: S.badge }, `${(graph.sharedSessions || []).length} 个总台`),
            h('span', { style: S.badge }, `${(graph.messages || []).length} 条消息`),
            graph.holds ? h('span', { style: { ...S.badge, color: C.warn } }, `限流暂存 ${graph.holds}`) : null,
            graph.pending ? h('span', { style: { ...S.badge, color: C.warn } }, `待切会话 ${graph.pending}`) : null,
            h('span', { style: { flex: 1 } }),
            props && typeof props.closePanel === 'function'
              ? h('button', { style: S.btn, onClick: props.closePanel }, '回会话')
              : null,
            h('button', { style: S.btn, onClick: load }, '刷新'),
          ),
          h('div', { style: S.small },
            host.sessions ? `会话通道可用${host.prompt ? '（可投消息）' : '（只能切）'}` : `${host.reason || '会话通道不可用'}`,
            '｜数据：', meta.status === 'ok' ? '正常' : meta.status,
          ),
          meta.status && meta.status !== 'ok' && meta.status !== 'missing'
            ? h('div', { style: { color: C.danger, fontSize: '11px', marginTop: '6px' } }, (meta.warnings || []).join('；') || meta.error || '')
            : null,
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '这条内容，发给谁？'),
          h('textarea', {
            style: { ...S.input, minHeight: '56px', resize: 'vertical' },
            placeholder: '标题 + 一两句：比如「大肥鱼切片第 3 期，聊到塔防开局」',
            value: text,
            onChange: (e) => setText(e.target.value),
          }),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('input', {
              style: { ...S.input, flex: 1, width: 'auto' },
              placeholder: '关键词（逗号分隔，可空）',
              value: tags,
              onChange: (e) => setTags(e.target.value),
            }),
            h('button', { style: S.primary, onClick: doFor }, '算一下'),
          ),
          forError ? h('div', { style: { color: C.danger, fontSize: '11px', marginTop: '6px' } }, forError) : null,
          picks
            ? h('div', null,
                (picks.picks || []).map((p) => h('div', { key: p.id, style: S.pick },
                  h('div', { style: S.row },
                    h('span', { style: S.name }, `发给：${p.name}`),
                    h('span', { style: S.badge }, `${p.score} 分`),
                    h('span', { style: { flex: 1 } }),
                    h('button', { style: S.btn, onClick: () => activate({ name: p.name }, text.trim()) }, '投到会话'),
                    h('button', { style: S.btn, onClick: () => activate({ name: p.name }) }, '只切会话'),
                  ),
                  h('div', { style: S.small }, `理由：${(p.reasons || []).join('；')}`),
                  h('div', { style: S.small }, `通道：${p.channelText || '还没记通道'}`),
                  h('div', { style: S.small }, `会话：${sessionLabel(p.session)}`),
                )),
                (picks.alternatives || []).length
                  ? h('div', { style: S.small }, `备选：${picks.alternatives.map((a) => `${a.name}（${a.score}）`).join('、')}`)
                  : null,
              )
            : null,
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '找个人'),
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, flex: 1, width: 'auto' },
              placeholder: '名字 / 别名 / 爱好 / 聊过的事',
              value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') doSearch()
              },
            }),
            h('button', { style: S.btn, onClick: doSearch }, '搜'),
          ),
          hits === null
            ? null
            : hits.length
              ? hits.map((x) => h('div', { key: x.id, style: S.small }, `- ${x.name}（亲密 ${x.affinity}）｜${x.field}：${x.hit}`))
              : h('div', { style: S.small }, '没找到。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '朋友圈'),
          graph.friends.length
            ? h('div', { style: S.grid }, graph.friends.map((f) => h(Buddy, {
                key: f.id,
                f,
                onOpen: (x) => activate(x),
                onNote: note,
                onShare: markSent,
              })))
            : h('div', { style: S.small }, '鱼友簿还是空的。让机器人先 friends_upsert 记几个人。'),
        ),

        h(GoalSection, { graph, onChanged: load, say }),
        h(BridgesSection, { graph, onChanged: load, say }),
        h(RoutingSection, { graph, onChanged: load, say }),
        h(MessagesSection, { graph, onChanged: load, say }),
        h(ProactiveSection, { graph, onChanged: load, say }),
        toast ? h('div', { style: S.toast }, toast) : null,
      )
    }

    /** 浮层：把 host 排队的激活变成真实的会话跳转。 */
    function ActivationWatcher({ ctx }) {
      const [toast, setToast] = useState('')

      useEffect(() => {
        let stopped = false
        let timer = null

        const openSession = (a) => {
          try {
            if (a.kind === 'url') {
              window.open(a.sessionId, '_blank', 'noopener')
              return true
            }
            const ws = ctx.get ? ctx.get('uiWorkspace') : ctx.uiWorkspace
            if (ws && typeof ws.openSession === 'function') {
              ws.openSession(a.sessionId)
              return true
            }
          } catch {
            /* 切不过去就退回提示 */
          }
          return false
        }

        const tick = async () => {
          try {
            const res = await api('/pending')
            const list = (res.data && res.data.pending) || []
            if (!list.length || stopped) return
            for (const a of list) {
              const ok = openSession(a)
              if (!stopped) {
                setToast(ok ? `已切到 ${a.friendName || '好友会话'}` : `请手动切到 ${a.friendName || a.sessionId}`)
                setTimeout(() => !stopped && setToast(''), 4000)
              }
              try {
                await api('/pending/ack', { method: 'POST', body: { ids: [a.id] } })
              } catch {
                /* 下次再 ack */
              }
            }
          } catch {
            /* 后端没起来就静默，下次再试 */
          }
        }

        tick()
        timer = setInterval(tick, 5000)
        return () => {
          stopped = true
          if (timer) clearInterval(timer)
        }
      }, [ctx])

      if (!toast) return null
      return h('div', { style: S.toast }, toast)
    }

    /** 左侧栏图标：main 面板的入口（这里只收到 { size, active }）。 */
    function FishFriendsIcon({ size = 18, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        style: { opacity: active ? 1 : 0.75 },
      },
        h('circle', { cx: 9, cy: 8, r: 3.1 }),
        h('path', { d: 'M3.6 19.2c.6-3 2.8-4.6 5.4-4.6s4.8 1.6 5.4 4.6' }),
        h('circle', { cx: 17.4, cy: 9.4, r: 2.3 }),
        h('path', { d: 'M15.3 18.8c.4-2.1 1.8-3.2 3.7-3.2' }),
      )
    }

    const PANEL_ID = 'dsh-fish-friends'

    return {
      // 服务名（不是包名）：slots 注册插槽，layout 用来切面板，uiWorkspace 用来切会话
      inject: ['slots', 'layout', 'uiWorkspace'],
      // 冒烟测试用：不装宿主也能把各区块渲染一遍，抓「拿对象当子节点」这类运行时错误
      __test__: { BridgesSection, RoutingSection, MessagesSection, ProactiveSection, GoalSection },
      apply(ctx) {
        // 全局面板：main 是 keyed slot，key 就是面板 id
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            // inject 的返回值直接成为组件 props：给页面一个「回会话」的出口
            inject: () => ({
              closePanel: () => {
                try {
                  ctx.layout.selectPanel(null)
                } catch {
                  /* 老版本没有 layout 就忽略 */
                }
              },
            }),
          }, FishFriendsPage)),
          'fish-friends: main panel',
        )

        // 左侧栏入口：id 必须等于 main 的 key，点图标才会 selectPanel(id)
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 44,
            label: () => '鱼友簿',
          }, FishFriendsIcon)),
          'fish-friends: sidebar entry',
        )

        // 浮层常驻：把 host 排队的激活变成真实的会话跳转（面板没开也要生效）
        ctx.effect(
          () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-fish-friends-activation',
            order: 77,
          }, () => h(ActivationWatcher, { ctx }))),
          'fish-friends: activation watcher',
        )
      },
    }
  },
})
