/** Package-owned invariant companion for the Lisp runtime runner. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lisp-runtime-runner'

export const name = 'lisp-runtime-runner-invariant'
export const inject = ['invariants']

// No runtime invariant: the SBCL process owns its package/run lifecycle, and
// adapter receipts are appended atomically by each awaited public operation.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
