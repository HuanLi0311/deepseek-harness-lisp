/** Public types for the SBCL-backed dynamic package runner. */

import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  DynamicCordisInvokeResult,
  CordisDynamicRunMode,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
} from '@deepseek-ai/dsh-cordis-host-runner/types'

/** One JSON object sent as a JSON-RPC params value. */
export type JsonObject = { [key: string]: JsonValue }

/** A transport for one long-lived Lisp JSON-RPC process. */
export interface JsonRpcTransport {
  /** Send one request and resolve with its JSON result. */
  request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown>
  /** Stop the process and reject any outstanding requests. */
  close(): Promise<void>
}

/** Options for the default child-process transport. */
export interface LispRuntimeProcessOptions {
  /** SBCL executable or another compatible Lisp launcher. */
  command?: string
  /** Explicit launcher arguments; defaults to the runtime stdio entrypoint. */
  args?: string[]
  /** Runtime root containing `apps/stdio.lisp` when args are omitted. */
  runtimeRoot?: string
  /** Child working directory. */
  cwd?: string
  /** Environment additions/replacements for the child. */
  env?: NodeJS.ProcessEnv
  /** Per-request response deadline. */
  requestTimeoutMs?: number
  /** Maximum time to wait for an orderly child shutdown. */
  shutdownTimeoutMs?: number
}

/** Configuration for the Host service. */
export interface Config extends LispRuntimeProcessOptions {}

/** Lisp Package source stored by the runtime as immutable data. */
export interface LispPackageDefinition {
  /** Existing Plugin to version, or a new Plugin prefix. */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** Session that owns the Plugin. */
  sessionId: SessionId
  /** Human-readable Package name. */
  name: string
  /** Human-readable Package purpose. */
  purpose: string
  /** Exactly one readable Common Lisp form. */
  form: string
}

/** Define receipt mapped from the existing dynamic-runner vocabulary. */
export interface LispDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: true
  hasClientHalf: false
}

/** One source-free Lisp Package summary. */
export interface LispPackageSummary {
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: true
  hasClientHalf: boolean
}

/** One source-free Lisp run inspection. */
export interface LispRunInspection {
  pluginRunId: CordisDynamicPluginRunId
  packageId: CordisDynamicPackageId
  status: string
  provides: string[]
  handlers: string[]
  clientHandlers: string[]
  tools: string[]
  error?: string
}

/** Plugin inspection returned by the Lisp runtime. */
export interface LispPluginInspection {
  mode: 'plugin'
  pluginId: CordisDynamicPluginId
  sessionId: SessionId
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: LispRunInspection
  latestRun?: LispRunInspection
  packages: LispPackageSummary[]
}

/** Exact Package inspection with its original Lisp form. */
export interface LispPackageInspection {
  mode: 'package'
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  form: string
  runtime?: LispRunInspection
}

/** Process-wide read-only runtime inventory. */
export interface LispRuntimeInspection {
  services: Array<{ name: string; ownerRun?: string }>
  events: string[]
  tools: Array<{ name: string; description: string; parameters: JsonValue; sessionId: SessionId }>
  plugins: Array<{
    pluginId: CordisDynamicPluginId
    sessionId: SessionId
    currentPackageId?: CordisDynamicPackageId
    nextPackageId?: CordisDynamicPackageId
    activeRun?: LispRunInspection
  }>
}

/** Operations written to the owning Session log. */
export type LispRuntimeLifecycleOperation = 'define' | 'run' | 'stop' | 'rollback' | 'undefine' | 'invoke'

/** Durable lifecycle record appended after a runtime operation settles. */
export interface LispRuntimeLifecycleEventData {
  operation: LispRuntimeLifecycleOperation
  sessionId: SessionId
  ok: boolean
  pluginId?: CordisDynamicPluginId
  packageId?: CordisDynamicPackageId
  pluginRunId?: CordisDynamicPluginRunId
  mode?: CordisDynamicRunMode
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  result?: JsonValue
  error?: { code?: string; message: string }
}

/** Session append surface used by the adapter; keeps tests independent of Context. */
export interface LispRuntimeSession {
  readonly id: SessionId
  append(type: 'lisp-runtime/lifecycle', data: LispRuntimeLifecycleEventData): unknown
}

/** Resolve a live DSH Session by its branded identity. */
export type LispRuntimeSessionResolver = (sessionId: SessionId) => LispRuntimeSession | undefined

/** Options for the in-process runner facade. */
export interface LispRuntimeRunnerOptions {
  transport?: JsonRpcTransport
  process?: LispRuntimeProcessOptions
  sessionResolver?: LispRuntimeSessionResolver
}

/** Runtime operation used by the adapter's public run method. */
export interface LispRunRequest {
  sessionId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  mode: CordisDynamicRunMode
  signal?: AbortSignal
}

/** Public facade implemented by {@link LispRuntimeRunner}. */
export interface LispRuntimeRunnerApi {
  define(request: LispPackageDefinition): Promise<LispDefineReceipt>
  inspect(
    sessionId: SessionId,
    pluginId?: CordisDynamicPluginId,
    packageId?: CordisDynamicPackageId,
  ): Promise<LispRuntimeInspection | LispPluginInspection | LispPackageInspection>
  run(request: LispRunRequest): Promise<DynamicCordisRunResponse>
  stop(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse>
  rollback(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<DynamicCordisRunResponse>
  undefine(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt>
  invoke(
    sessionId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    method: string,
    argumentsValue: JsonValue,
  ): Promise<DynamicCordisInvokeResult>
  close(): Promise<void>
}
