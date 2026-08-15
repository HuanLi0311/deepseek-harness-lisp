# @deepseek-ai/dsh-lisp-runtime-runner

English | [中文](README.zh.md)

`LispRuntimeRunnerService` is an opt-in Host adapter for dynamic Lisp Packages.
It starts the sibling `deepseek-harness-lisp-runtime` SBCL JSON-RPC process on
first use and exposes it at `ctx.lispRuntimeRunner`.

The adapter keeps the existing dynamic-runner identifiers and receipts:
`pluginId`, `packageId`, `pluginRunId`, `currentPackageId`,
`nextPackageId`, `inspect`, `run`, `stop`, `rollback`, and `undefine`. It
records every settled lifecycle operation as `lisp-runtime/lifecycle` in the
owning DSH Session.

The existing JavaScript `ctx.dynamicCordisRunner` remains unchanged. Compose
this service explicitly where Lisp package forms should be accepted.

Set `DSH_LISP_RUNTIME_ROOT` to override the sibling runtime path, or configure
`command`, `args`, `runtimeRoot`, `cwd`, and request timeouts when mounting the
service. The default command is `sbcl`.

## Limitations

The Lisp runtime currently owns only the Host half of a dynamic extension.
Browser rendering and client approval continue to use the existing JavaScript
runner. Lisp forms execute inside SBCL, so deployments must apply their normal
process and filesystem policy to that executable.
