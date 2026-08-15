# @deepseek-ai/dsh-lisp-runtime-runner

[English](README.md) | 中文

`LispRuntimeRunnerService` 是用于动态 Lisp Package 的可选 Host 适配器。它在
第一次调用时启动同级 `deepseek-harness-lisp-runtime` 的 SBCL JSON-RPC 进程，
并通过 `ctx.lispRuntimeRunner` 提供服务。

适配器保留现有动态运行器的标识和回执：`pluginId`、`packageId`、
`pluginRunId`、`currentPackageId`、`nextPackageId`、`inspect`、`run`、`stop`、
`rollback` 与 `undefine`。每个已结算的生命周期操作都会作为
`lisp-runtime/lifecycle` 写入所属 DSH Session。

现有 JavaScript `ctx.dynamicCordisRunner` 保持不变。仅在需要接受 Lisp
package form 的 Host 组合中显式挂载此服务。

可用 `DSH_LISP_RUNTIME_ROOT` 覆盖同级运行时路径，也可以在挂载服务时配置
`command`、`args`、`runtimeRoot`、`cwd` 和请求超时。默认命令为 `sbcl`。

## 限制

Lisp runtime 当前只拥有动态扩展的 Host 半边。浏览器渲染和客户端审批仍使用
现有 JavaScript runner。Lisp form 在 SBCL 中执行，部署环境需要为该可执行文件
配置正常的进程与文件系统策略。
