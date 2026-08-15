# DeepSeek Harness Lisp Runtime Proposal

本 proposal 的核心思路是：不把 D:\python\nanoGPT\deepseek-harness 全部改写成 Lisp，
只把其中的动态扩展运行时改写成 Lisp。

D:\python\nanoGPT\DSH 原本就支持在运行中新增、激活、停止、更新插件，并且通过
plugin/package/run 与 currentPackageId/nextPackageId 保留可回溯的改动状态。
这些特性和 Lisp 的“代码即数据”思想很接近。因此我们希望让 Agent 的插件
不只是普通源码文件或 JS/TS source string，而是 Lisp 形式的 package form。
这个 package 可以被保存、检查、执行、更新和回滚。

## Baseline: first prove upstream DSH runs

先复现并验证原始 D:\python\nanoGPT\DSH 可以在本机运行。该步骤不需要本地部署
模型权重；Web UI 和工程构建只需要 Node.js、pnpm 和源码依赖。真实模型
请求需要 provider API key，例如 DeepSeek API key；如果后续改成必须依赖
本地权重的 provider，则跳过真实模型调用，只做 build/UI smoke test。

最小验证：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

预期结果：Web UI 能在默认端口启动，基础页面可打开。没有 API key 时不做
真实 agent turn；有 API key 时再补一个最小模型请求 smoke test。

## Rewrite idea

原始 DSH 已经有三层：

- Runtime: Cordis runtime、dynamic Cordis runner、plugin/package/run 生命周期。
- Host: session、tool registry、terminal、subprocess、LSP、MCP、storage、model adapter。
- Product/UI: Web UI、approval、session history、工具结果展示。

我们只替换 Runtime 中和动态扩展相关的核心：

- `packages/extensions/cordis-host-runner`
- dynamic package/plugin/run registry
- activation/update/rollback lifecycle
- dynamic plugin inspection and invocation

不兼容旧的动态插件内部写法是可以接受的：旧逻辑是 JS/TS source string，
新逻辑是 Lisp form。外层产品边界尽量保留，例如 `pluginId`、`packageId`、
`pluginRunId`、`currentPackageId`、`nextPackageId`、inspect/run/stop/rollback
结果结构和 session event 语义。这样 Web、Session、工具和历史查询不需要
被一起推倒。

推荐形态：

```text
DeepSeek Harness TS Host
  -> Lisp runner adapter
  -> SBCL Lisp runtime process
  -> Lisp Package / Plugin / Run
```

## What already exists in `deepseek-harness-lisp-runtime`

`D:\python\nanoGPT\deepseek-harness-lisp-runtime` 已经完成了一个可复用的
动态扩展运行时垂直切片：

- `define-package`: 保存不可变 package form。
- `activate-package`: 激活 package，支持 `:run` 和 `:update`。
- `stop-plugin`: 停止当前 run，并清理副作用。
- `rollback-plugin`: 显式回到上一个成功版本。
- `undefine-plugin`: 删除 plugin 和所有 package 版本。
- `current-package-id` / `next-package-id`: 保留成功版本和失败目标。
- Run 生命周期：tool、service、listener、handler、effect 归属到 run。
- 失败清理：启动失败不会留下半挂载资源。
- 自反工具：inspect、define、run、stop、rollback。

当前 runtime 测试已覆盖：

- waiting lifecycle and disposal
- failed update and rollback
- native self-tools
- client-half lifecycle

这部分可以直接作为新 runner 的语义内核，而不是在 TypeScript 里重新实现
一遍 Lisp runtime。

## How to reuse it with less rewrite cost

最小改法：

1. 保留原始 DSH 的 Host/Product/UI。
2. 新增一个 Lisp-backed dynamic runner adapter。
3. adapter 通过 stdio/JSON-RPC 调 SBCL runtime。
4. adapter 把 Lisp runtime receipt 映射回 DSH 现有 dynamic runner wire shape。
5. runtime lifecycle event 由 adapter append 到 DSH session。

先不做：

- 不重写 terminal/subprocess/storage/web。
- 不把 session persistence 搬进 Lisp runtime。
- 不一开始支持完整 dynamic Client half 渲染。
- 不尝试复刻文件级 HMR；文件 HMR 是开发层，Lisp package update 是 Agent 运行时层。

这样改动集中在一个新 adapter 和 dynamic runner 边界上，避免从
`deepseek-harness-lisp` 反向补齐全部非 Lisp 基础设施。

## Expected contribution

原始 DSH 已经能动态加载插件，但插件主体仍然更像不透明源码。改写后的贡献是：

> 把 Agent 动态扩展从 source string 升级成结构化 Lisp program object，使其
> 可以被 inspect、version、transform、activate、rollback，并进入 session
> history 形成可追踪的能力演化链。

换言之，这不是“给 DSH 增加 Lisp 语言支持”，而是把动态插件机制升级成
Lisp-native agent self-extension runtime。

## Robustness checks after the rewrite

每个阶段只跑能覆盖改动面的最小检查：

```sh
pnpm run build
pnpm run typecheck
pnpm test -- packages/extensions/lisp-runtime-runner
sbcl --noinform --non-interactive --load ..\deepseek-harness-lisp-runtime\tests\tests.lisp
```

关键行为测试：

- define 后能 inspect 到 package form。
- run 成功后设置 `currentPackageId`。
- update 失败后保留旧 `currentPackageId`，记录失败 `nextPackageId`。
- rollback 能重新激活旧版本并清除失败目标。
- stop/undefine 后 tool、service、listener、handler 都被清理。
- stale `pluginRunId` 调用被拒绝。
- runtime lifecycle event 被写入 session，并可通过 session-query 查到。
- Web UI 在无本地模型权重时仍可启动；真实模型请求只在 provider key 存在时验证。

后续再扩大到 `pnpm run check:all`、Web e2e、snapshot replay 和真实 API e2e。

改动期间任何进展请及时同步推送到 https://github.com/HuanLi0311/deepseek-harness-lisp main分支 邮箱huanhuanli104@gmail.com 忽视之前已有的提交 覆盖即可