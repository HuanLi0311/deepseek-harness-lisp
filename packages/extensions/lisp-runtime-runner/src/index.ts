/** SBCL-backed dynamic Package runner for Lisp-native Agent extensions. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
} from '@deepseek-ai/dsh-cordis-host-runner'
import type {
  CordisDynamicPackageId as PackageId,
  CordisDynamicPluginId as PluginId,
  CordisDynamicPluginRunId as RunId,
  DynamicCordisInvokeResult,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
import { SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionId as SessionIdentity } from '@deepseek-ai/dsh-session/types'
import { LispRuntimeProcess, LispRuntimeRpcError, defaultRuntimeRoot } from './transport.ts'
import type {
  Config,
  JsonObject,
  JsonRpcTransport,
  LispDefineReceipt,
  LispPackageDefinition,
  LispPackageInspection,
  LispPackageSummary,
  LispPluginInspection,
  LispRunInspection,
  LispRunRequest,
  LispRuntimeInspection,
  LispRuntimeLifecycleEventData,
  LispRuntimeRunnerApi,
  LispRuntimeRunnerOptions,
  LispRuntimeSession,
} from './types.ts'

export type * from './types.ts'
export { LispRuntimeProcess, LispRuntimeRpcError, defaultRuntimeArgs, defaultRuntimeRoot } from './transport.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only receipt of one Lisp runtime lifecycle operation. */
    'lisp-runtime/lifecycle': LispRuntimeLifecycleEventData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SBCL-backed Lisp Package registry and lifecycle adapter. */
    lispRuntimeRunner: LispRuntimeRunnerService
  }
}

type RunFailureReason = Extract<DynamicCordisRunResponse, { ok: false }>['reason']
type InvokeFailureCode = Extract<DynamicCordisInvokeResult, { ok: false }>['code']

/** Lisp runtime runner with a replaceable JSON-RPC transport. */
export class LispRuntimeRunner implements LispRuntimeRunnerApi {
  private readonly transport: JsonRpcTransport
  private readonly sessionResolver: LispRuntimeRunnerOptions['sessionResolver']

  /**
   * Create a runner facade.
   * @param options - transport, child process, and Session lookup options.
   */
  constructor(options: LispRuntimeRunnerOptions = {}) {
    this.transport = options.transport ?? new LispRuntimeProcess(options.process)
    this.sessionResolver = options.sessionResolver
  }

  /**
   * Define an immutable Lisp Package in the runtime.
   * @param request - owner, metadata, and one readable Lisp form.
   * @returns the runtime-minted Plugin and Package identities.
   */
  async define(request: LispPackageDefinition): Promise<LispDefineReceipt> {
    requireNonEmpty(request.form, 'form')
    const params: JsonObject = {
      'session-id': request.sessionId,
      name: request.name,
      purpose: request.purpose,
      form: request.form,
    }
    if (request.plugin.kind === 'new') params['id-prefix'] = request.plugin.idPrefix
    else params['plugin-id'] = request.plugin.pluginId
    try {
      const raw = await this.transport.request('cordis/define', params)
      const receipt = mapDefine(raw)
      await this.appendLifecycle('define', request.sessionId, receipt, {}, raw)
      return receipt
    } catch (error) {
      await this.appendFailure('define', request.sessionId, error, {
        ...(request.plugin.kind === 'existing' ? { pluginId: request.plugin.pluginId } : {}),
      })
      throw error
    }
  }

  /**
   * Inspect the process-wide runtime, one Plugin, or one Package.
   * @param sessionId - Session whose ownership scope is inspected.
   * @param pluginId - optional Plugin identity to narrow the report.
   * @param packageId - optional Package identity to return its form.
   * @returns a source-free inventory or an exact Package form.
   */
  async inspect(
    sessionId: SessionIdentity,
    pluginId?: PluginId,
    packageId?: PackageId,
  ): Promise<LispRuntimeInspection | LispPluginInspection | LispPackageInspection> {
    const params: JsonObject = { 'session-id': sessionId }
    if (pluginId !== undefined) params['plugin-id'] = pluginId
    if (packageId !== undefined) params['package-id'] = packageId
    const raw = await this.transport.request('cordis/inspect', params)
    const record = requireRecord(raw, 'inspect response')
    if (packageId !== undefined) return mapPackageInspection(record)
    if (pluginId !== undefined) return mapPluginInspection(record)
    return mapRuntimeInspection(record)
  }

  /**
   * Activate a Package using the existing `run`/`update` wire vocabulary.
   * @param request - owner, target Package, mode, and optional cancellation.
   * @returns the mapped activation receipt or a dynamic-runner refusal.
   */
  async run(request: LispRunRequest): Promise<DynamicCordisRunResponse> {
    const params: JsonObject = {
      'session-id': request.sessionId,
      'plugin-id': request.pluginId,
      'package-id': request.packageId,
      mode: request.mode,
    }
    try {
      const raw = await this.transport.request('cordis/run', params, request.signal)
      const result = mapRun(raw, request.mode)
      await this.appendLifecycle('run', request.sessionId, result, {
        pluginId: request.pluginId,
        packageId: request.packageId,
        mode: request.mode,
      }, raw)
      return result
    } catch (error) {
      const result: DynamicCordisRunResponse = {
        ok: false,
        reason: mapRunFailure(error),
        message: errorMessage(error),
      }
      await this.appendLifecycle('run', request.sessionId, result, {
        pluginId: request.pluginId,
        packageId: request.packageId,
        mode: request.mode,
      })
      return result
    }
  }

  /**
   * Stop one active Package Run while retaining its definitions.
   * @param sessionId - owning Session.
   * @param pluginId - stable Plugin identity.
   * @returns a mapped stop receipt.
   */
  async stop(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisStopResponse> {
    try {
      const raw = await this.transport.request('cordis/stop', {
        'session-id': sessionId,
        'plugin-id': pluginId,
      })
      const result = mapStop(raw)
      await this.appendLifecycle('stop', sessionId, result, { pluginId }, raw)
      return result
    } catch (error) {
      if (!isMissingRuntimeError(error)) throw error
      const result: DynamicCordisStopResponse = { ok: false, reason: 'plugin-missing', message: errorMessage(error) }
      await this.appendLifecycle('stop', sessionId, result, { pluginId })
      return result
    }
  }

  /**
   * Re-activate the last successful Package version.
   * @param sessionId - owning Session.
   * @param pluginId - stable Plugin identity.
   * @returns a normal dynamic-runner activation receipt.
   */
  async rollback(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisRunResponse> {
    try {
      const raw = await this.transport.request('cordis/rollback', {
        'session-id': sessionId,
        'plugin-id': pluginId,
      })
      const result = mapRun(raw, 'run')
      await this.appendLifecycle('rollback', sessionId, result, { pluginId, mode: 'run' }, raw)
      return result
    } catch (error) {
      const result: DynamicCordisRunResponse = {
        ok: false,
        reason: mapRunFailure(error),
        message: errorMessage(error),
      }
      await this.appendLifecycle('rollback', sessionId, result, { pluginId, mode: 'run' })
      return result
    }
  }

  /**
   * Remove a Plugin and all of its Package versions.
   * @param sessionId - owning Session.
   * @param pluginId - stable Plugin identity.
   * @returns whether a Plugin was removed.
   */
  async undefine(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisUndefineReceipt> {
    try {
      const raw = await this.transport.request('cordis/undefine', {
        'session-id': sessionId,
        'plugin-id': pluginId,
      })
      const result = mapUndefine(raw)
      await this.appendLifecycle('undefine', sessionId, result, { pluginId }, raw)
      return result
    } catch (error) {
      if (!isMissingRuntimeError(error)) throw error
      const result: DynamicCordisUndefineReceipt = { ok: false, reason: 'plugin-missing', message: errorMessage(error) }
      await this.appendLifecycle('undefine', sessionId, result, { pluginId })
      return result
    }
  }

  /**
   * Invoke a Host handler registered by one exact active Run.
   * @param sessionId - owning Session.
   * @param pluginId - stable Plugin identity.
   * @param pluginRunId - exact active Run identity.
   * @param method - handler name.
   * @param argumentsValue - JSON arguments passed to the handler.
   * @returns the existing dynamic invoke result vocabulary.
   */
  async invoke(
    sessionId: SessionIdentity,
    pluginId: PluginId,
    pluginRunId: RunId,
    method: string,
    argumentsValue: JsonValue,
  ): Promise<DynamicCordisInvokeResult> {
    const params: JsonObject = {
      'session-id': sessionId,
      'plugin-id': pluginId,
      'plugin-run-id': pluginRunId,
      method,
      arguments: argumentsValue,
    }
    try {
      const raw = await this.transport.request('cordis/invoke', params)
      const result: DynamicCordisInvokeResult = { ok: true, value: asJsonValue(raw) }
      await this.appendLifecycle('invoke', sessionId, result, { pluginId, pluginRunId }, raw)
      return result
    } catch (error) {
      const result: DynamicCordisInvokeResult = {
        ok: false,
        code: mapInvokeFailure(error),
        message: errorMessage(error),
      }
      await this.appendLifecycle('invoke', sessionId, result, { pluginId, pluginRunId })
      return result
    }
  }

  /** Close the underlying process or injected transport. */
  close(): Promise<void> {
    return this.transport.close()
  }

  private async appendLifecycle(
    operation: LispRuntimeLifecycleEventData['operation'],
    sessionId: SessionIdentity,
    result: unknown,
    fallback: Partial<LispRuntimeLifecycleEventData> = {},
    source: unknown = result,
  ): Promise<void> {
    const session = this.sessionResolver?.(sessionId)
    if (session === undefined) return
    if (session.id !== sessionId) throw new Error(`Lisp runtime Session resolver returned "${session.id}" for "${sessionId}"`)
    const record = asRecord(source)
    const ok = asRecord(result)?.ok !== false
    const currentPackage = stringField(record, 'current-package-id', 'currentPackageId')
    const nextPackage = stringField(record, 'next-package-id', 'nextPackageId')
    const data: LispRuntimeLifecycleEventData = {
      operation,
      sessionId,
      ok,
      ...(fallback.pluginId === undefined ? {} : { pluginId: fallback.pluginId }),
      ...(fallback.packageId === undefined ? {} : { packageId: fallback.packageId }),
      ...(fallback.pluginRunId === undefined ? {} : { pluginRunId: fallback.pluginRunId }),
      ...(fallback.mode === undefined ? {} : { mode: fallback.mode }),
      ...(currentPackage === undefined ? {} : { currentPackageId: packageId(currentPackage) }),
      ...(nextPackage === undefined ? {} : { nextPackageId: packageId(nextPackage) }),
      result: asJsonValue(result),
    }
    const resultPluginId = stringField(record, 'plugin-id', 'pluginId')
    const resultPackageId = stringField(record, 'package-id', 'packageId')
    const resultRunId = stringField(record, 'plugin-run-id', 'pluginRunId')
    if (resultPluginId !== undefined && data.pluginId === undefined) data.pluginId = pluginId(resultPluginId)
    if (resultPackageId !== undefined && data.packageId === undefined) data.packageId = packageId(resultPackageId)
    if (resultRunId !== undefined && data.pluginRunId === undefined) data.pluginRunId = runId(resultRunId)
    session.append('lisp-runtime/lifecycle', data)
  }

  private async appendFailure(
    operation: LispRuntimeLifecycleEventData['operation'],
    sessionId: SessionIdentity,
    error: unknown,
    fallback: Partial<LispRuntimeLifecycleEventData>,
  ): Promise<void> {
    const session = this.sessionResolver?.(sessionId)
    if (session === undefined) return
    if (session.id !== sessionId) throw new Error(`Lisp runtime Session resolver returned "${session.id}" for "${sessionId}"`)
    const rpc = error instanceof LispRuntimeRpcError && error.code !== undefined ? { code: String(error.code) } : {}
    session.append('lisp-runtime/lifecycle', {
      operation,
      sessionId,
      ok: false,
      ...(fallback.pluginId === undefined ? {} : { pluginId: fallback.pluginId }),
      ...(fallback.packageId === undefined ? {} : { packageId: fallback.packageId }),
      ...(fallback.pluginRunId === undefined ? {} : { pluginRunId: fallback.pluginRunId }),
      ...(fallback.mode === undefined ? {} : { mode: fallback.mode }),
      error: { ...rpc, message: errorMessage(error) },
    })
  }
}

/** Cordis service wrapper for an opt-in Lisp runtime composition. */
export class LispRuntimeRunnerService extends Service implements LispRuntimeRunnerApi {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    command: z.string().default('sbcl'),
    args: z.array(z.string()).default([]),
    runtimeRoot: z.string().default(defaultRuntimeRoot()),
    cwd: z.string().default(''),
    requestTimeoutMs: z.number().min(1).default(30_000),
    shutdownTimeoutMs: z.number().min(1).default(2_000),
  })

  readonly runner: LispRuntimeRunner

  /** Create the service and tie child teardown to its Cordis fiber. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'lispRuntimeRunner')
    const sessionResolver = (sessionId: SessionIdentity): LispRuntimeSession | undefined => {
      const store = ctx.get('sessions') as { get(id: SessionIdentity): LispRuntimeSession | undefined } | undefined
      return store?.get(sessionId)
    }
    this.runner = new LispRuntimeRunner({
      process: {
        ...(config.command === undefined ? {} : { command: config.command }),
        ...(config.args === undefined || config.args.length === 0 ? {} : { args: [...config.args] }),
        ...(config.runtimeRoot === undefined ? {} : { runtimeRoot: config.runtimeRoot }),
        ...(config.cwd === undefined || config.cwd === '' ? {} : { cwd: config.cwd }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
        ...(config.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: config.shutdownTimeoutMs }),
      },
      sessionResolver,
    })
    ctx.effect(() => async () => { await this.runner.close() }, 'Lisp runtime process teardown')
  }
  define(request: LispPackageDefinition): Promise<LispDefineReceipt> { return this.runner.define(request) }
  inspect(
    sessionId: SessionIdentity,
    pluginId?: PluginId,
    packageId?: PackageId,
  ): Promise<LispRuntimeInspection | LispPluginInspection | LispPackageInspection> {
    return this.runner.inspect(sessionId, pluginId, packageId)
  }
  run(request: LispRunRequest): Promise<DynamicCordisRunResponse> { return this.runner.run(request) }
  stop(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisStopResponse> { return this.runner.stop(sessionId, pluginId) }
  rollback(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisRunResponse> {
    return this.runner.rollback(sessionId, pluginId)
  }
  undefine(sessionId: SessionIdentity, pluginId: PluginId): Promise<DynamicCordisUndefineReceipt> {
    return this.runner.undefine(sessionId, pluginId)
  }
  invoke(
    sessionId: SessionIdentity,
    pluginId: PluginId,
    pluginRunId: RunId,
    method: string,
    argumentsValue: JsonValue,
  ): Promise<DynamicCordisInvokeResult> {
    return this.runner.invoke(sessionId, pluginId, pluginRunId, method, argumentsValue)
  }
  close(): Promise<void> { return this.runner.close() }
}

function mapDefine(value: unknown): LispDefineReceipt {
  const record = requireRecord(value, 'define response')
  if (record.ok !== true) throw new Error(stringField(record, 'message') ?? 'Lisp runtime rejected define')
  return {
    pluginId: pluginId(requiredString(record, 'plugin-id', 'pluginId')),
    packageId: packageId(requiredString(record, 'package-id', 'packageId')),
    name: requiredString(record, 'name'),
    purpose: requiredString(record, 'purpose'),
    hasHostHalf: true,
    hasClientHalf: false,
  }
}

function mapRun(value: unknown, mode: 'run' | 'update'): DynamicCordisRunResponse {
  const record = requireRecord(value, 'run response')
  if (record.ok !== true) {
    const stack = stringField(record, 'stack')
    const failure: Extract<DynamicCordisRunResponse, { ok: false }> = {
      ok: false,
      reason: mapRunFailure(record.reason ?? record.message),
      message: stringField(record, 'message') ?? 'Lisp runtime rejected activation',
    }
    if (stack !== undefined) failure.stack = stack
    return failure
  }
  const current = stringField(record, 'current-package-id', 'currentPackageId')
  const next = stringField(record, 'next-package-id', 'nextPackageId')
  const status = stringField(record, 'status')
  const waitingFor = stringArray(record, 'waiting-for', 'waitingFor')
  return {
    ok: true,
    status: status === 'starting' ? 'starting' : 'running',
    pluginId: pluginId(requiredString(record, 'plugin-id', 'pluginId')),
    packageId: packageId(requiredString(record, 'package-id', 'packageId')),
    pluginRunId: runId(requiredString(record, 'plugin-run-id', 'pluginRunId')),
    waitingFor,
    ...(current === undefined ? {} : { currentPackageId: packageId(current) }),
    ...(next === undefined ? {} : { nextPackageId: packageId(next) }),
    mode,
  }
}

function mapStop(value: unknown): DynamicCordisStopResponse {
  const record = requireRecord(value, 'stop response')
  if (record.ok !== true) {
    return {
      ok: false,
      reason: stringField(record, 'reason') === 'not-running' ? 'not-running' : 'plugin-missing',
      message: stringField(record, 'message') ?? 'Lisp runtime rejected stop',
    }
  }
  return { ok: true }
}

function mapUndefine(value: unknown): DynamicCordisUndefineReceipt {
  const record = requireRecord(value, 'undefine response')
  if (record.ok !== true) return { ok: false, reason: 'plugin-missing', message: stringField(record, 'message') ?? 'Plugin is missing' }
  return { ok: true, wasRunning: record['was-running'] === true || record.wasRunning === true }
}

function mapRuntimeInspection(record: Record<string, unknown>): LispRuntimeInspection {
  return {
    services: records(record.services).map((service) => {
      const ownerRun = stringField(service, 'owner-run', 'ownerRun')
      return { name: requiredString(service, 'name'), ...(ownerRun === undefined ? {} : { ownerRun }) }
    }),
    events: stringArray(record, 'events'),
    tools: records(record.tools).map(tool => ({
      name: requiredString(tool, 'name'),
      description: requiredString(tool, 'description'),
      parameters: asJsonValue(tool.parameters),
      sessionId: SessionId(requiredString(tool, 'session-id', 'sessionId')),
    })),
    plugins: records(record.plugins).map(mapRuntimePlugin),
  }
}

function mapRuntimePlugin(record: Record<string, unknown>): LispRuntimeInspection['plugins'][number] {
  const current = stringField(record, 'current-package-id', 'currentPackageId')
  const next = stringField(record, 'next-package-id', 'nextPackageId')
  const activeRun = asOptionalRun(record, 'active-run', 'activeRun')
  return {
    pluginId: pluginId(requiredString(record, 'plugin-id', 'pluginId')),
    sessionId: SessionId(requiredString(record, 'session-id', 'sessionId')),
    ...(current === undefined ? {} : { currentPackageId: packageId(current) }),
    ...(next === undefined ? {} : { nextPackageId: packageId(next) }),
    ...(activeRun === undefined ? {} : { activeRun }),
  }
}

function mapPluginInspection(record: Record<string, unknown>): LispPluginInspection {
  const current = stringField(record, 'current-package-id', 'currentPackageId')
  const next = stringField(record, 'next-package-id', 'nextPackageId')
  const activeRun = asOptionalRun(record, 'active-run', 'activeRun')
  const latestRun = asOptionalRun(record, 'latest-run', 'latestRun')
  return {
    mode: 'plugin',
    pluginId: pluginId(requiredString(record, 'plugin-id', 'pluginId')),
    sessionId: SessionId(requiredString(record, 'session-id', 'sessionId')),
    ...(current === undefined ? {} : { currentPackageId: packageId(current) }),
    ...(next === undefined ? {} : { nextPackageId: packageId(next) }),
    ...(activeRun === undefined ? {} : { activeRun }),
    ...(latestRun === undefined ? {} : { latestRun }),
    packages: records(record.packages).map(mapPackageSummary),
  }
}

function mapPackageInspection(record: Record<string, unknown>): LispPackageInspection {
  const current = stringField(record, 'current-package-id', 'currentPackageId')
  const next = stringField(record, 'next-package-id', 'nextPackageId')
  const runtime = asOptionalRun(record, 'runtime')
  return {
    mode: 'package',
    pluginId: pluginId(requiredString(record, 'plugin-id', 'pluginId')),
    packageId: packageId(requiredString(record, 'package-id', 'packageId')),
    name: requiredString(record, 'name'),
    purpose: requiredString(record, 'purpose'),
    ...(current === undefined ? {} : { currentPackageId: packageId(current) }),
    ...(next === undefined ? {} : { nextPackageId: packageId(next) }),
    form: requiredString(record, 'form'),
    ...(runtime === undefined ? {} : { runtime }),
  }
}

function mapPackageSummary(record: Record<string, unknown>): LispPackageSummary {
  return {
    packageId: packageId(requiredString(record, 'package-id', 'packageId')),
    name: requiredString(record, 'name'),
    purpose: requiredString(record, 'purpose'),
    hasHostHalf: true,
    hasClientHalf: record['has-client-half'] === true || record.hasClientHalf === true,
  }
}

function asOptionalRun(record: Record<string, unknown>, ...keys: string[]): LispRunInspection | undefined {
  const value = firstField(record, keys)
  return value === null || value === undefined ? undefined : mapRunInspection(value)
}

function mapRunInspection(value: unknown): LispRunInspection {
  const record = requireRecord(value, 'run inspection')
  const error = stringField(record, 'error')
  return {
    pluginRunId: runId(requiredString(record, 'plugin-run-id', 'pluginRunId')),
    packageId: packageId(requiredString(record, 'package-id', 'packageId')),
    status: requiredString(record, 'status'),
    provides: stringArray(record, 'provides'),
    handlers: stringArray(record, 'handlers'),
    clientHandlers: stringArray(record, 'client-handlers', 'clientHandlers'),
    tools: stringArray(record, 'tools'),
    ...(error === undefined ? {} : { error }),
  }
}

function mapRunFailure(value: unknown): RunFailureReason {
  const reason = errorMessage(value).toLowerCase()
  if (reason.includes('package') && (reason.includes('not') || reason.includes('does not exist'))) return 'package-missing'
  if (reason.includes('plugin') && (reason.includes('not') || reason.includes('does not exist') || reason.includes('not owned'))) return 'plugin-missing'
  if (reason.includes('mode') || reason.includes('current package')) return 'invalid-mode'
  if (reason.includes('transition') || reason.includes('starting')) return 'transition-in-flight'
  if (reason.includes('cancel')) return 'cancelled'
  if (reason.includes('not running')) return 'not-running'
  return 'host-half-failed'
}

function mapInvokeFailure(error: unknown): InvokeFailureCode {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('not running activation')) return 'stale-run'
  if (message.includes('not registered')) return 'method-not-found'
  if (message.includes('does not exist') || message.includes('not owned')) return 'plugin-not-running'
  return 'handler-error'
}

function isMissingRuntimeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes('does not exist') || message.includes('not owned') || message.includes('not found')
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`${label} must be a JSON object`)
  return record
}

function records(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Lisp runtime returned a non-array collection')
  return value.map((item, index) => requireRecord(item, `Lisp runtime collection item ${index}`))
}

function stringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  const value = firstField(record, keys)
  if (value === null || value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Lisp runtime returned a non-string array')
  return [...value]
}

function requiredString(record: Record<string, unknown>, ...keys: string[]): string {
  const value = stringField(record, ...keys)
  if (value === undefined) throw new Error(`Lisp runtime response is missing ${keys[0] ?? 'string'}`)
  return value
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (record === undefined) return undefined
  const value = firstField(record, keys)
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Lisp runtime response field ${keys[0] ?? 'value'} must be a string`)
  return value
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asJsonValue(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error('Lisp runtime returned a non-JSON value')
  return snapshot as JsonValue
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Lisp Package ${field} must be non-empty`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pluginId(value: string): PluginId { return CordisDynamicPluginId(value) }
function packageId(value: string): PackageId { return CordisDynamicPackageId(value) }
function runId(value: string): RunId { return CordisDynamicPluginRunId(value) }

export default LispRuntimeRunnerService
