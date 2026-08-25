/**
 * 面向 DeepSeek Harness ACP 服务端的最小客户端封装。
 *
 * 底层使用官方 `@agentclientprotocol/sdk` 的 `ClientSideConnection`，通过
 * stdio 的 NDJSON 与 ACP server 通信。本文件只做三件事：
 * 1. 把 SDK 的原生 RPC（initialize / session/new / session/prompt / cancel）
 *    收敛成 `createSession` / `session.prompt` / `session.cancel` 这样的高层 API；
 * 2. 在客户端侧累积服务端推送的 `agent_message_chunk`，让 prompt 返回完整文本；
 * 3. 提供自动应答工具权限请求的默认策略，避免交互卡住自动化流程。
 *
 * 注意：ACP 协议没有"销毁会话"的本地原语，服务端也未实现 `session/close`，
 * 因此 `destroy()` 只在客户端侧取消在途回合并丢弃本地状态；真正的资源回收
 * 由 `close()`（向 stdin 写 EOF，触发服务端优雅退出）完成。
 */

import { Readable, Writable, type Readable as NodeReadable, type Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'

/** 一次 prompt 回合结束后拿到的 agent 输出。 */
export interface AgentMessage {
  /** 本回合 agent 输出的完整文本（按序拼接所有 text chunk）。 */
  text: string
  /** ACP 停止原因（end_turn / max_tokens / cancelled ...）。 */
  stopReason: StopReason
}

/** prompt 的返回结果，`agentMessage.text` 即最终答复文本。 */
export interface PromptResult {
  agentMessage: AgentMessage
}

/** 单个 ACP 会话的句柄，对应服务端的一个 agent。 */
export interface AcpSession {
  /** 服务端分配的会话 id（仅在当前 server 进程内唯一）。 */
  readonly id: string
  /** 发送一条 prompt 并等待该回合结束。 */
  prompt(params: { text: string }): Promise<PromptResult>
  /** 取消当前进行中的 prompt 回合（best-effort）。 */
  cancel(): Promise<void>
  /** 客户端侧销毁会话：取消在途回合并丢弃本地累积的文本。 */
  destroy(): Promise<void>
}

/** `AcpClient` 构造参数。 */
export interface AcpClientOptions {
  /** 子进程的 stdin —— 客户端写 JSON-RPC 请求的出口。 */
  stdin: NodeWritable
  /** 子进程的 stdout —— 客户端读 JSON-RPC 响应/通知的入口。 */
  stdout: NodeReadable
  /**
   * 工具权限的自动应答策略：
   * - `allow`：服务端请求权限时选择第一个 allow 选项（默认）；
   * - `reject`：一律返回 cancelled，agent 将无法执行需要授权的操作。
   */
  permission?: 'allow' | 'reject'
  /** 可选回调：每个 `session/update` 通知到达时触发，可用于流式打印。 */
  onUpdate?: (update: SessionNotification['update']) => void
}

/**
 * ACP 客户端。构造后调用 {@link createSession} 建立会话，再通过会话发送
 * prompt；退出时调用 {@link close} 向 stdin 写 EOF 让服务端优雅退出。
 */
export class AcpClient {
  private readonly conn: ClientSideConnection
  /** sessionId → 该会话累积的 agent 文本片段（按通知到达顺序）。 */
  private readonly textBySession = new Map<string, string[]>()
  private closed = false

  /**
   * @param options - 子进程 stdio 流、权限策略与可选的更新回调。
   */
  constructor(options: AcpClientOptions) {
    const input = Writable.toWeb(options.stdin) as WritableStream<Uint8Array>
    const output = Readable.toWeb(options.stdout) as ReadableStream<Uint8Array>
    const client: Client = {
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        const update = params.update
        // 只累积最终交付的 agent 文本；thought / tool_call / plan 等更新
        // 仅透传给 onUpdate，不进入 prompt 的返回值。
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          const parts = this.textBySession.get(params.sessionId)
          if (parts !== undefined) parts.push(update.content.text)
        }
        options.onUpdate?.(update)
        return Promise.resolve()
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // allow 策略选择第一个 allow 类选项；reject 或没有 allow 选项时返回
        // cancelled，让服务端把权限请求折叠成一次拒绝，而不是挂起回合。
        if (options.permission !== 'reject') {
          const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
          if (allow !== undefined) {
            return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
          }
        }
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    }
    this.conn = new ClientSideConnection(() => client, ndJsonStream(input, output))
  }

  /**
   * 初始化协议并创建一个 ACP 会话。
   * @param params - `workspace` 为会话工作目录，必须是绝对路径。
   * @returns 会话句柄；其 `prompt()` 已绑定该会话 id。
   */
  async createSession(params: { workspace: string }): Promise<AcpSession> {
    if (this.closed) throw new Error('AcpClient is closed')
    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // 客户端不提供 fs/terminal 等可选能力，agent 在自己的工作目录里自助完成。
      clientCapabilities: {},
    })
    const response = await this.conn.newSession({ cwd: params.workspace, mcpServers: [] })
    const sessionId = response.sessionId
    this.textBySession.set(sessionId, [])
    let destroyed = false
    return {
      id: sessionId,
      prompt: async (prompt: { text: string }): Promise<PromptResult> => {
        const parts = this.textBySession.get(sessionId)
        if (parts === undefined) throw new Error(`session is not tracked: ${sessionId}`)
        // 清空上个回合累积的文本，保证返回值只含当前回合的输出。
        parts.length = 0
        const result = await this.conn.prompt({
          sessionId,
          prompt: [{ type: 'text', text: prompt.text }],
        })
        return { agentMessage: { text: parts.join(''), stopReason: result.stopReason } }
      },
      cancel: async (): Promise<void> => {
        await this.conn.cancel({ sessionId })
      },
      destroy: async (): Promise<void> => {
        if (destroyed) return
        destroyed = true
        // 服务端未实现 session/close：先取消在途回合，再丢弃本地累积状态。
        await this.conn.cancel({ sessionId }).catch(() => { /* 回合可能已结束 */ })
        this.textBySession.delete(sessionId)
      },
    }
  }

  /**
   * 关闭客户端：向 stdin 写 EOF，让服务端进入优雅退出（flush 持久化后
   * 自行退出进程）。调用后所有会话句柄失效。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const conn = this.conn
    // EOF 触发服务端 quiesce；最多等 10s，超时后由调用方负责 kill 子进程。
    await Promise.race([
      conn.closed,
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]).catch(() => { /* 连接可能从未建立，忽略 */ })
  }
}
