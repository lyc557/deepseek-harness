/**
 * ACP client 端到端 demo：spawn 一个 dsh ACP server 子进程，用 {@link AcpClient}
 * 创建会话、发送真实 prompt，最后优雅关闭。
 *
 * 运行方式（在仓库根目录）：
 *   node --import tsx acp-client/demo.ts [--workspace <目录>] [--provider <名>] [--model <模型id>] [--prompt <文本>]
 *
 * 默认值：
 *   --workspace /Users/luyangcai/code/todo
 *   --provider  apple-mlx        （读 ~/.dsh/settings.yaml 的 llm-pi-ai.providers 节）
 *   --model     qwen3.8-27b-mlx
 *
 * 本脚本会做两件事让 ACP server 使用指定模型：
 * 1. 从 `~/.dsh/settings.yaml` 提取 `llm-pi-ai.providers.<provider>` 路由，
 *    用 `@deepseek-ai/dsh-llm-pi-ai` 替换示例配置里的 `dsh-llm-deepseek`，
 *    生成一份临时 cordis.yml（保留其余全部插件，原样不动）；
 * 2. 把 `acp-agent` 的 provider/model 改成参数值，并把 provider 路由声明的
 *    `apiKeyEnv` 凭据（环境变量或 `~/.dsh/.credentials.yaml`）注入子进程。
 */

import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { AcpClient } from './acp-client.ts'

/** 本文件所在目录（仓库根/acp-client）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：server bin 与示例配置的相对路径都以它为基准。 */
const REPO_ROOT = join(HERE, '..')
/** 默认工作目录：agent 在其中执行任务。 */
const DEFAULT_WORKSPACE = '/Users/luyangcai/code/todo'
/** 默认 provider 路由（对应 ~/.dsh/settings.yaml 的 llm-pi-ai.providers.apple-mlx）。 */
const DEFAULT_PROVIDER = 'apple-mlx'
/** 默认模型 id（即 settings.yaml 中 agent-default-model.model）。 */
const DEFAULT_MODEL = 'qwen3.8-27b-mlx'
/** 默认 prompt：只读浏览项目，避免 demo 误改真实代码。 */
const DEFAULT_PROMPT = '三江转债价格和溢价率？'
/** 给子进程留出的退出等待窗口（ms），超时后用 SIGKILL 兜底。 */
const EXIT_GRACE_MS = 10_000

/**
 * 解析某个凭据：优先取环境变量，其次回退到 `~/.dsh/.credentials.yaml`。
 * @param ref - 凭据名，如 DEEPSEEK_API_KEY / APPLE_MLX_API_KEY。
 * @returns 找到的凭据值，或 undefined。
 */
function resolveCredential(ref: string): string | undefined {
  if (process.env[ref] !== undefined) return process.env[ref]
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${ref}:\\s*"?([^"\\s]+)"?\\s*$`, 'm').exec(yaml)
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * 从 `~/.dsh/settings.yaml` 提取 `llm-pi-ai.providers.<provider>` 的 YAML 块。
 * @param provider - provider 路由名，如 apple-mlx。
 * @returns 该路由的原始行数组（保留原缩进），未找到返回 undefined。
 */
function extractProviderBlock(provider: string): string[] | undefined {
  const yaml = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
  const lines = yaml.split('\n')
  // 定位 `llm-pi-ai:` 顶层节。
  const ns = lines.findIndex(line => /^llm-pi-ai:\s*$/.test(line))
  if (ns === -1) return undefined
  // 在节内定位 `  providers:`（缩进 2）。
  let prov = -1
  for (let i = ns + 1; i < lines.length; i++) {
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break // 已离开 llm-pi-ai 节
    if (/^  providers:\s*$/.test(lines[i])) { prov = i; break }
  }
  if (prov === -1) return undefined
  // 定位 `    <provider>:`（缩进 4）。
  let key = -1
  for (let i = prov + 1; i < lines.length; i++) {
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break // 已离开 providers 节
    const indent = lines[i].length - lines[i].trimStart().length
    if (indent === 4 && lines[i].trimStart().startsWith(`${provider}:`)) { key = i; break }
  }
  if (key === -1) return undefined
  // 收集该路由的整块：后续行中，空行或缩进 ≥ 6 的行都属于它。
  const block: string[] = [lines[key]!]
  for (let i = key + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') { block.push(line); continue }
    const indent = line.length - line.trimStart().length
    if (indent < 6) break
    block.push(line)
  }
  return block
}

/**
 * 把 provider 路由渲染成 `llm-pi-ai` 插件条目（config.providers 下缩进 2）。
 * @param block - 该路由的原始 YAML 行（来自 settings.yaml，首行即 `<provider>:`）。
 * @returns 可直接写进 cordis.yml 的插件条目文本。
 */
function renderPiAiEntry(block: string[]): string {
  const indented = block.map(line => (line.trim() === '' ? line : `  ${line}`)).join('\n')
  return [
    `- id: llm-pi-ai`,
    `  name: '@deepseek-ai/dsh-llm-pi-ai'`,
    `  config:`,
    `    providers:`,
    indented,
  ].join('\n')
}

/**
 * 基于示例配置生成"指定 provider/model"的 cordis.yml：仅替换 LLM 适配器
 * 条目与 acp-agent 的 provider/model 两处，其余字节原样保留。
 * @param base - 示例 cordis.yml 原文。
 * @param piAiEntry - 渲染好的 llm-pi-ai 条目。
 * @param provider - 目标 provider 路由名。
 * @param model - 目标模型 id。
 * @returns 生成后的配置文本。
 */
function patchConfig(base: string, piAiEntry: string, provider: string, model: string): string {
  const start = base.indexOf('# The DeepSeek adapter.')
  const end = base.indexOf('# The default composition')
  if (start === -1 || end === -1) {
    throw new Error('示例配置结构变化，无法定位 LLM 适配器段')
  }
  const head = base.slice(0, start)
  const tail = base.slice(end)
  const replacement = [
    '# 本地 OpenAI-compatible 网关适配器（llm-pi-ai）：以下 provider 路由由 demo',
    '# 从 ~/.dsh/settings.yaml 的 llm-pi-ai.providers 节生成，provider/model 来自命令行参数。',
    piAiEntry,
  ].join('\n')
  // acp-agent 的 provider/model 两个连续字段（config 下缩进 4）。
  const agentOld = '    provider: deepseek-official\n    model: deepseek-v4-pro'
  const agentNew = `    provider: ${provider}\n    model: ${model}`
  if (!base.includes(agentOld)) {
    throw new Error('示例配置中未找到 acp-agent 的 provider/model 字段')
  }
  return head + replacement + '\n\n' + tail.replace(agentOld, agentNew)
}

/**
 * 取 provider 路由块声明的 apiKeyEnv。
 * @param block - provider 路由的 YAML 行。
 * @returns 凭据环境变量名，未声明返回 undefined。
 */
function apiKeyEnvOf(block: string[]): string | undefined {
  const line = block.find(line => /^ {6}apiKeyEnv:/.test(line))
  return line?.trim().slice('apiKeyEnv:'.length).trim()
}

/**
 * 等一个子进程退出；超时未退出时先 SIGTERM 再 SIGKILL。
 * @param child - 已 spawn 的子进程。
 */
async function reapProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve_ => child.once('exit', () => resolve_()))
  const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
  child.kill('SIGTERM')
  await exited
  clearTimeout(timer)
}

/**
 * 流式打印服务端推送的 session 更新（agent 文本直接输出，工具调用给标题）。
 * @param update - 一条 session/update 通知。
 */
function makeLogger(update: SessionNotification['update']): void {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text)
  } else if (update.sessionUpdate === 'tool_call') {
    process.stdout.write(`\n[tool] ${update.title} (${update.status})\n`)
  }
}

/** 主流程：spawn server → 建会话 → 发 prompt → 关闭。 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      workspace: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
    },
  })
  const workspace = resolve(values.workspace ?? DEFAULT_WORKSPACE)
  const provider = values.provider ?? DEFAULT_PROVIDER
  const model = values.model ?? DEFAULT_MODEL
  const prompt = values.prompt ?? DEFAULT_PROMPT

  await access(workspace).catch(() => {
    throw new Error(`工作目录不存在: ${workspace}`)
  })

  // 1. 从用户 settings.yaml 提取 provider 路由，并生成 llm-pi-ai 条目。
  const block = extractProviderBlock(provider)
  if (block === undefined) {
    throw new Error(`~/.dsh/settings.yaml 中未找到 llm-pi-ai.providers.${provider}`)
  }
  const apiKeyEnv = apiKeyEnvOf(block)
  const credential = apiKeyEnv === undefined ? undefined : resolveCredential(apiKeyEnv)
  if (apiKeyEnv !== undefined && credential === undefined) {
    throw new Error(`未找到 ${apiKeyEnv}（环境变量或 ~/.dsh/.credentials.yaml）`)
  }

  // 2. 生成一份临时 cordis.yml：替换 LLM 适配器 + 改写 provider/model。
  const base = await readFile(join(REPO_ROOT, 'examples', 'acp-agent', 'cordis.yml'), 'utf8')
  const generated = patchConfig(base, renderPiAiEntry(block), provider, model)
  const configDir = await mkdtemp(join(tmpdir(), 'acp-config-'))
  const configPath = join(configDir, 'cordis.yml')
  await writeFile(configPath, generated)

  // 3. spawn ACP server（源码模式，`--config` 指向生成的配置）。
  console.log(`工作目录: ${workspace}`)
  console.log(`使用模型: ${provider}/${model}${apiKeyEnv !== undefined ? `（凭据 ${apiKeyEnv}）` : ''}`)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/examples/acp-demo/src/bin.ts', '--config', configPath],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(apiKeyEnv !== undefined && credential !== undefined ? { [apiKeyEnv]: credential } : {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  if (child.stdin === null || child.stdout === null) throw new Error('spawn 未提供管道流')
  child.on('error', error => console.error(`[server] spawn 失败: ${String(error)}`))

  // 4. 创建客户端，流式打印 agent 输出。
  const client = new AcpClient({
    stdin: child.stdin,
    stdout: child.stdout,
    permission: 'allow',
    onUpdate: makeLogger,
  })

  try {
    // 5. 创建会话并发送 prompt。
    const session = await client.createSession({ workspace })
    console.log(`会话 id: ${session.id}`)
    console.log('\n>>> agent 输出:')
    const result = await session.prompt({ text: prompt })
    console.log(`\n\n>>> 停止原因: ${result.agentMessage.stopReason}`)

    // 6. 演示 cancel/destroy 生命周期（回合已结束，均为 no-op 级别的调用）。
    await session.cancel()
    await session.destroy()
  } finally {
    // 7. EOF → 服务端优雅退出；随后兜底收尸、清理临时配置。
    await client.close().catch(() => { /* 连接可能已中断 */ })
    await reapProcess(child)
    await rm(configDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(`demo 失败: ${String(error)}`)
  process.exitCode = 1
})
