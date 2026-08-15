import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import {
  LispRuntimeRpcError,
  LispRuntimeRunner,
  type JsonObject,
  type JsonRpcTransport,
  type LispRuntimeLifecycleEventData,
  type LispRuntimeSession,
} from '../src/index.ts'

class FakeTransport implements JsonRpcTransport {
  readonly calls: Array<{ method: string; params: JsonObject }> = []
  readonly replies: unknown[]
  closed = false

  constructor(...replies: unknown[]) {
    this.replies = replies
  }

  async request(method: string, params: JsonObject): Promise<unknown> {
    this.calls.push({ method, params })
    const reply = this.replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function recordingSession(id = SessionId('session-lisp')): {
  session: LispRuntimeSession
  events: LispRuntimeLifecycleEventData[]
} {
  const events: LispRuntimeLifecycleEventData[] = []
  return {
    session: {
      id,
      append(_type, data): void { events.push(data) },
    },
    events,
  }
}

describe('LispRuntimeRunner', () => {
  it('maps lifecycle receipts and retains failed-update package state in the Session', async () => {
    const { session, events } = recordingSession()
    const transport = new FakeTransport(
      {
        ok: true,
        'plugin-id': 'clock-1',
        'package-id': 'pkg-1',
        name: 'clock',
        purpose: 'test clock',
      },
      {
        ok: true,
        status: 'waiting',
        'plugin-id': 'clock-1',
        'package-id': 'pkg-1',
        'plugin-run-id': 'run-1',
        'waiting-for': ['clock-service'],
        'next-package-id': 'pkg-1',
      },
      {
        ok: false,
        reason: 'activation-failed',
        message: 'broken update',
        'plugin-id': 'clock-1',
        'package-id': 'pkg-2',
        'plugin-run-id': 'run-2',
        'current-package-id': 'pkg-1',
        'next-package-id': 'pkg-2',
      },
    )
    const runner = new LispRuntimeRunner({
      transport,
      sessionResolver: id => id === session.id ? session : undefined,
    })

    const defined = await runner.define({
      sessionId: session.id,
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'clock',
      purpose: 'test clock',
      form: '(list :name "clock" :apply (lambda (ctx) (declare (ignore ctx))))',
    })
    const waiting = await runner.run({
      sessionId: session.id,
      pluginId: defined.pluginId,
      packageId: defined.packageId,
      mode: 'run',
    })
    const failed = await runner.run({
      sessionId: session.id,
      pluginId: defined.pluginId,
      packageId: CordisDynamicPackageId('pkg-2'),
      mode: 'update',
    })

    expect(waiting).toMatchObject({ ok: true, status: 'running', waitingFor: ['clock-service'] })
    expect(failed).toMatchObject({ ok: false, reason: 'host-half-failed', message: 'broken update' })
    expect(events).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({
      operation: 'run',
      ok: false,
      pluginId: CordisDynamicPluginId('clock-1'),
      packageId: CordisDynamicPackageId('pkg-2'),
      currentPackageId: CordisDynamicPackageId('pkg-1'),
      nextPackageId: CordisDynamicPackageId('pkg-2'),
    })
    expect(transport.calls.map(call => call.method)).toEqual(['cordis/define', 'cordis/run', 'cordis/run'])
  })

  it('maps stale invocation errors and closes its injected transport', async () => {
    const { session, events } = recordingSession()
    const transport = new FakeTransport(
      new LispRuntimeRpcError('cordis/invoke', 'plugin "clock-1" is not running activation "run-1"', -32000),
    )
    const runner = new LispRuntimeRunner({
      transport,
      sessionResolver: id => id === session.id ? session : undefined,
    })

    await expect(runner.invoke(
      session.id,
      CordisDynamicPluginId('clock-1'),
      CordisDynamicPluginRunId('run-1'),
      'echo',
      { value: 1 } as JsonValue,
    )).resolves.toMatchObject({ ok: false, code: 'stale-run' })
    expect(events.at(-1)).toMatchObject({ operation: 'invoke', ok: false, pluginRunId: CordisDynamicPluginRunId('run-1') })

    await runner.close()
    expect(transport.closed).toBe(true)
  })
})

const lispRuntimeRoot = resolve(process.cwd(), '..', 'deepseek-harness-lisp-runtime')
const sbclAvailable = spawnSync('sbcl', ['--version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!sbclAvailable)('LispRuntimeRunner with SBCL', () => {
  it('runs the define-update-rollback-stop lifecycle over stdio JSON-RPC', async () => {
    const { session, events } = recordingSession(SessionId('session-sbcl'))
    const runner = new LispRuntimeRunner({
      process: { runtimeRoot: lispRuntimeRoot, requestTimeoutMs: 10_000 },
      sessionResolver: id => id === session.id ? session : undefined,
    })
    try {
      const first = await runner.define({
        sessionId: session.id,
        plugin: { kind: 'new', idPrefix: 'echo' },
        name: 'echo',
        purpose: 'integration test',
        form: '(list :name "echo" :apply (lambda (ctx) (dsh-lisp-runtime:ctx-handle ctx "echo" (lambda (args) args))))',
      })
      const started = await runner.run({
        sessionId: session.id,
        pluginId: first.pluginId,
        packageId: first.packageId,
        mode: 'run',
      })
      expect(started).toMatchObject({ ok: true, currentPackageId: first.packageId })
      if (!started.ok) throw new Error(started.message)

      await expect(runner.invoke(session.id, first.pluginId, started.pluginRunId, 'echo', { value: 7 }))
        .resolves.toEqual({ ok: true, value: { value: 7 } })
      const inspected = await runner.inspect(session.id, first.pluginId, first.packageId)
      expect(inspected).toMatchObject({ mode: 'package', form: expect.stringMatching(/ctx-handle/i) })

      const broken = await runner.define({
        sessionId: session.id,
        plugin: { kind: 'existing', pluginId: first.pluginId },
        name: 'broken',
        purpose: 'failed update',
        form: '(error "broken update")',
      })
      const failed = await runner.run({
        sessionId: session.id,
        pluginId: first.pluginId,
        packageId: broken.packageId,
        mode: 'update',
      })
      expect(failed).toMatchObject({ ok: false, reason: 'host-half-failed' })
      const afterFailure = await runner.inspect(session.id, first.pluginId)
      expect(afterFailure).toMatchObject({ currentPackageId: first.packageId, nextPackageId: broken.packageId })

      const rolledBack = await runner.rollback(session.id, first.pluginId)
      expect(rolledBack).toMatchObject({ ok: true, currentPackageId: first.packageId })
      if (!rolledBack.ok) throw new Error(rolledBack.message)
      await expect(runner.stop(session.id, first.pluginId)).resolves.toEqual({ ok: true })
      await expect(runner.invoke(session.id, first.pluginId, rolledBack.pluginRunId, 'echo', { value: 8 }))
        .resolves.toMatchObject({ ok: false, code: 'stale-run' })
      await expect(runner.undefine(session.id, first.pluginId)).resolves.toEqual({ ok: true, wasRunning: false })
      expect(events.map(event => event.operation)).toEqual([
        'define', 'run', 'invoke', 'define', 'run', 'rollback', 'stop', 'invoke', 'undefine',
      ])
      expect(events.find(event => event.operation === 'run' && !event.ok)).toMatchObject({
        currentPackageId: first.packageId,
        nextPackageId: broken.packageId,
      })
    } finally {
      await runner.close()
    }
  }, 30_000)
})
