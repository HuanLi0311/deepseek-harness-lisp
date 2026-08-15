/** JSON-RPC transport for one long-lived SBCL runtime process. */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonRpcTransport, JsonObject, LispRuntimeProcessOptions } from './types.ts'

/** A JSON-RPC error returned by the Lisp process. */
export class LispRuntimeRpcError extends Error {
  /** JSON-RPC error code, when supplied by the server. */
  readonly code: number | string | undefined
  /** Method that produced the error. */
  readonly method: string

  constructor(method: string, message: string, code?: number | string) {
    super(message)
    this.name = 'LispRuntimeRpcError'
    this.method = method
    this.code = code
  }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

interface JsonRpcResponse {
  id?: unknown
  result?: unknown
  error?: unknown
}

/** Resolve the sibling Lisp runtime used by the workspace default. */
export function defaultRuntimeRoot(): string {
  const configured = process.env.DSH_LISP_RUNTIME_ROOT
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const packageDirectory = dirname(fileURLToPath(import.meta.url))
  return resolve(packageDirectory, '../../../../..', 'deepseek-harness-lisp-runtime')
}

/** Build default SBCL arguments for the runtime's JSONL entrypoint. */
export function defaultRuntimeArgs(runtimeRoot: string): string[] {
  return ['--noinform', '--non-interactive', '--load', join(runtimeRoot, 'apps', 'stdio.lisp')]
}

/**
 * A line-oriented JSON-RPC client over stdin/stdout.
 *
 * The child is lazy: a Host composition can include this service without
 * requiring SBCL until a Lisp Package operation is requested.
 */
export class LispRuntimeProcess implements JsonRpcTransport {
  private readonly options: Required<Pick<LispRuntimeProcessOptions, 'command' | 'requestTimeoutMs' | 'shutdownTimeoutMs'>>
  private readonly args: string[]
  private child: ChildProcessWithoutNullStreams | undefined
  private starting: Promise<void> | undefined
  private exit: Promise<void> | undefined
  private closed = false
  private nextRequestId = 1
  private stdout = ''
  private stderr = ''
  private readonly pending = new Map<number, PendingRequest>()

  constructor(options: LispRuntimeProcessOptions = {}) {
    this.options = {
      command: options.command ?? 'sbcl',
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
    }
    const runtimeRoot = resolve(options.runtimeRoot ?? defaultRuntimeRoot())
    this.args = [...options.args ?? defaultRuntimeArgs(runtimeRoot)]
    this.spawnOptions = {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
    }
  }

  private readonly spawnOptions: { cwd?: string; env: NodeJS.ProcessEnv }

  /** Send one request and wait for its matching response. */
  async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Lisp runtime process is closed')
    signal?.throwIfAborted()
    const child = await this.ensureChild()
    signal?.throwIfAborted()
    const id = this.nextRequestId++
    const timeoutMs = this.options.requestTimeoutMs
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectResponse(new LispRuntimeRpcError(method, `request timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      const pending: PendingRequest = {
        method,
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.pending.delete(id)
          clearTimeout(timer)
          rejectResponse(signal.reason ?? new Error('Lisp runtime request aborted'))
        }
        pending.signal = signal
        pending.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, pending)
    })
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    try {
      child.stdin.write(line, (error?: Error | null) => {
        if (error !== undefined && error !== null) this.rejectPending(id, error)
      })
    } catch (error) {
      this.rejectPending(id, error)
    }
    return response
  }

  /** Close stdin, then terminate the child if it does not exit promptly. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (child === undefined) {
      this.rejectAll(new Error('Lisp runtime process closed'))
      return
    }
    this.rejectAll(new Error('Lisp runtime process closed'))
    child.stdin.end()
    const exit = this.exit
    if (exit !== undefined) {
      await Promise.race([exit, delay(this.options.shutdownTimeoutMs)])
    }
    if (this.child === child && child.exitCode === null) child.kill()
    if (this.exit !== undefined) await this.exit.catch(() => {})
    this.child = undefined
  }

  private async ensureChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child !== undefined) return this.child
    if (this.starting !== undefined) {
      await this.starting
      if (this.child === undefined) throw new Error('Lisp runtime process exited during startup')
      return this.child
    }
    this.starting = Promise.resolve().then(() => {
      if (this.closed) throw new Error('Lisp runtime process is closed')
      const runtimeScript = this.args.includes('--load')
        ? this.args[this.args.indexOf('--load') + 1]
        : undefined
      if (runtimeScript !== undefined && !existsSync(runtimeScript)) {
        throw new Error(`Lisp runtime entrypoint does not exist: ${runtimeScript}`)
      }
      const child = spawn(this.options.command, this.args, {
        cwd: this.spawnOptions.cwd,
        env: this.spawnOptions.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      this.exit = new Promise<void>((resolveExit) => {
        child.once('exit', (code, signal) => {
          this.child = undefined
          const suffix = this.stderr.length === 0 ? '' : `\nstderr:\n${this.stderr}`
          const reason = new Error(`Lisp runtime exited${code === null ? ` by ${signal ?? 'signal'}` : ` with code ${code}`}${suffix}`)
          this.rejectAll(reason)
          resolveExit()
        })
      })
      child.stdout.on('data', (chunk: Buffer | string) => { this.readStdout(String(chunk)) })
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000)
      })
      child.once('error', (error) => { this.rejectAll(error) })
    }).finally(() => { this.starting = undefined })
    await this.starting
    if (this.child === undefined) throw new Error('Lisp runtime process exited during startup')
    return this.child
  }

  private readStdout(chunk: string): void {
    this.stdout += chunk
    for (;;) {
      const newline = this.stdout.indexOf('\n')
      if (newline < 0) return
      const line = this.stdout.slice(0, newline).trim()
      this.stdout = this.stdout.slice(newline + 1)
      if (line.length === 0) continue
      let response: JsonRpcResponse
      try {
        response = JSON.parse(line) as JsonRpcResponse
      } catch (error) {
        this.rejectAll(new LispRuntimeRpcError('protocol', `invalid JSON response: ${String(error)}`))
        continue
      }
      if (!Number.isSafeInteger(response.id)) continue
      const id = response.id as number
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      if (response.error !== undefined) {
        const error = asRecord(response.error)
        const code = error?.code
        this.rejectPending(id, new LispRuntimeRpcError(
          pending.method,
          typeof error?.message === 'string' ? error.message : 'Lisp runtime returned an unknown JSON-RPC error',
          typeof code === 'number' || typeof code === 'string' ? code : undefined,
        ))
      } else {
        this.resolvePending(id, response.result)
      }
    }
  }

  private resolvePending(id: number, value: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.resolve(value)
  }

  private rejectPending(id: number, reason: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.reject(reason)
  }

  private rejectAll(reason: unknown): void {
    for (const id of this.pending.keys()) this.rejectPending(id, reason)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds) })
}
