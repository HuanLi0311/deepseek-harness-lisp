(defpackage #:dsh-lisp-runtime
  (:use #:cl)
  (:shadow #:run)
  (:export
   ;; Conditions.
   #:dsh-error
   #:dsh-error-message
   #:dsh-validation-error
   #:dsh-plugin-not-found
   #:dsh-package-not-found
   #:dsh-activation-error
   #:dsh-service-error
   #:dsh-tool-error

   ;; Runtime and Agent.
   #:dsh-runtime
   #:make-runtime
   #:dsh-agent
   #:make-agent
   #:agent-runtime
   #:agent-session-id

   ;; Definitions and lifecycle.
   #:define-package
   #:activate-package
   #:stop-plugin
   #:undefine-plugin
   #:rollback-plugin
   #:find-plugin
   #:find-package-record
   #:plugin-id
   #:package-id
   #:package-form
   #:plugin-form
   #:plugin-current-package-id
   #:plugin-next-package-id
   #:plugin-active-run

   ;; Context capabilities.
   #:ctx-get
   #:ctx-provide
   #:ctx-on
   #:ctx-effect
   #:ctx-register-tool
   #:ctx-handle
   #:ctx-client-handle
   #:ctx-agent

   ;; Runtime operations.
   #:runtime-get-service
   #:runtime-provide-service
   #:runtime-remove-service
   #:runtime-emit
   #:runtime-call-tool
   #:runtime-invoke
   #:runtime-invoke-client

   ;; Reflection and tools.
   #:inspect-runtime
   #:inspect-plugin
   #:inspect-package
   #:install-self-tools
   #:register-builtin-tool
   #:remove-builtin-tool
   #:agent-call-tool
   #:agent-inspect))
