// 鱼友簿宿主入口：注册工具 + 面板 HTTP 接口 + 后台运行时（桥接轮询 / 主动闲聊 / 交友目标 / 限流补投）。
import { registerTools } from './lib/tools.js'
import { createHttpHandler } from './lib/http.js'
import { readDb } from './lib/store.js'
import { startBridgeRuntime } from './lib/bridge.js'
import { ingestIncoming, releaseHolds } from './lib/routing.js'
import { tickProactive } from './lib/proactive.js'
import { tickGoal } from './lib/goal.js'

export const inject = ['tools', 'webServer', 'sessionController', 'sessionQuery']

export function apply(ctx) {
  const logger = ctx.logger
  registerTools(ctx)

  const http = createHttpHandler(ctx)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: http.path, handler: http.handler }), 'fish-friends: http')

  // 后台运行时：桥接每 1s 看一次文件桥的新消息；每 60s 补投限流消息 + 看要不要主动找人。
  ctx.effect(() => {
    const stopBridges = startBridgeRuntime({
      readDb,
      ingest: (msg) => {
        void ingestIncoming(ctx, msg).catch((e) => logger?.warn?.(`鱼友簿：处理桥接消息失败 ${e?.message || e}`))
      },
      onError: (text) => logger?.warn?.(`鱼友簿：桥接出错 ${text}`),
    })
    const timer = setInterval(() => {
      void releaseHolds(ctx)
        .then((r) => {
          if (r.released) logger?.info?.(`鱼友簿：限流补投 ${r.released} 条`)
        })
        .catch((e) => logger?.warn?.(`鱼友簿：补投失败 ${e?.message || e}`))
      void tickProactive(ctx)
        .then((r) => {
          for (const s of r.sent || []) {
            if (s.ok) logger?.info?.(`鱼友簿：主动找 ${s.name} 聊了一句`)
            else logger?.warn?.(`鱼友簿：主动找 ${s.name} 失败 ${s.error}`)
          }
        })
        .catch((e) => logger?.warn?.(`鱼友簿：主动闲聊失败 ${e?.message || e}`))
      void tickGoal(ctx)
        .then((r) => {
          if (r.ok && (r.sent || []).some((s) => s.ok)) logger?.info?.(`鱼友簿：交友目标没达标，已提醒 ${r.sent.filter((s) => s.ok).length} 个总台`)
          else if (r.skipped) logger?.info?.(`鱼友簿：交友目标这次没提醒（${r.skipped}）`)
        })
        .catch((e) => logger?.warn?.(`鱼友簿：交友目标提醒失败 ${e?.message || e}`))
    }, 60000)
    if (timer.unref) timer.unref()
    return () => {
      stopBridges()
      clearInterval(timer)
    }
  }, 'fish-friends: runtime')

  logger?.info?.(`鱼友簿已加载：19 个工具 + 面板接口 ${http.path} + 桥接/主动闲聊/交友目标运行时`)
}
