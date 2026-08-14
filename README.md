# DSH Lisp Runtime

This directory is the first, independent Lisp implementation of the
self-reflective runtime described by `deepseek-harness`.

It is intentionally a Common Lisp system with no third-party dependencies.
The implementation is a host-side vertical slice, not a line-by-line rewrite
of the TypeScript repository.

## What is implemented

- Immutable Lisp Package definitions stored as data.
- Stable Plugin identities and Package version identities.
- `:run`, `:update`, stop, undefine, and explicit rollback lifecycle.
- `current-package-id` and `next-package-id` recovery pointers.
- Service provide/get with dependency waiting and retry.
- Event listeners owned by a Run.
- Session-scoped Tools owned by a Run.
- Host handlers for Client-to-Host calls.
- Run-owned effects and reverse disposal.
- Agent-scoped runtime inspection with values and closures omitted.
- Native self-tools for inspect, define, run, stop, and undefine.
- Common Lisp condition reporting for activation and Tool failures.

## Lisp Package form

The stored form evaluates to a descriptor. `plugin-form` is a convenience
macro for writing that descriptor while keeping the original form available to
the inspector.

```lisp
(define-package
 runtime "session-1"
 :id-prefix "clock"
 :name "clock"
 :purpose "provide a clock service"
 :form
 '(dsh-lisp-runtime:plugin-form (:name "clock")
    (ctx-provide ctx "clock" (lambda () (get-universal-time)))))
```

The form is not activated by `define-package`. Call `activate-package` with
`:mode :run` for the first run, or `:mode :update` when switching from an
existing successful version. A failed update leaves the previous
`current-package-id` and the failed `next-package-id` inspectable. Call
`rollback-plugin` to explicitly reactivate the previous version.

## Load and test

With SBCL or another ANSI Common Lisp implementation:

```text
sbcl --noinform --non-interactive --load tests/tests.lisp
```

ASDF users can load `dsh-lisp-runtime.asd` and then call:

```lisp
(asdf:load-system "dsh-lisp-runtime")
(dsh-lisp-runtime:install-self-tools agent)
```

SBCL 2.x is the verified implementation in this workspace. The source keeps
the runtime dependency-free so it can also be checked by CLISP or another
conforming implementation.

## Relationship to DSH

The design is mapped from:

- `packages/extensions/cordis-host-runner/src/types.ts`
- `packages/extensions/cordis-host-runner/src/registry.ts`
- `packages/extensions/tool-cordis/src/prompt.ts`

The second-stage `deepseek-harness-lisp` directory now provides the JSON-RPC,
JSON-file Session, and model-adapter boundary over this runtime. Browser
Client packages, subprocess/MCP integrations, and the Python SDK remain
separate migration tracks.
