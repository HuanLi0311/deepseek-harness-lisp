(in-package #:dsh-lisp-runtime)

(defun context-runtime (context)
  (dsh-context-runtime context))

(defun context-run (context)
  (dsh-context-run context))

(defun context-live-p (context)
  (member (dsh-run-record-status (context-run context))
          '(:starting :waiting :running)))

(defun require-live-context (context)
  (unless (context-live-p context)
    (fail 'dsh-activation-error "the owning Package Run is no longer live"))
  context)

(defun push-effect (run disposer)
  (unless (functionp disposer)
    (fail 'dsh-validation-error "effect disposer must be a function"))
  (push disposer (dsh-run-record-effects run))
  disposer)

(defun ctx-agent (context)
  (dsh-context-agent context))

(defun ctx-get (context name)
  "Read an optional Service from the live runtime." 
  (require-live-context context)
  (runtime-get-service (context-runtime context) name))

(defun ctx-provide (context name value)
  "Provide a Service owned by the current Run." 
  (require-live-context context)
  (let ((runtime (context-runtime context))
        (run (context-run context)))
    (runtime-provide-service runtime name value run)
    (push-effect run
                 (lambda ()
                   (runtime-remove-service runtime name run)))
    value))

(defun ctx-effect (context disposer)
  "Register a custom disposer on the current Run." 
  (require-live-context context)
  (push-effect (context-run context) disposer))

(defun ctx-on (context event handler)
  "Register an Event listener whose lifetime belongs to the current Run." 
  (require-live-context context)
  (unless (functionp handler)
    (fail 'dsh-validation-error "event handler must be a function"))
  (let* ((runtime (context-runtime context))
         (run (context-run context))
         (listener (%make-listener-record
                    :id (next-id runtime 'next-listener "listener")
                    :event (runtime-key event)
                    :handler handler
                    :owner-run run)))
    (setf (dsh-runtime-listeners runtime)
          (append (dsh-runtime-listeners runtime) (list listener)))
    (push listener (dsh-run-record-listeners run))
    (push-effect run (lambda () (remove-listener-record runtime listener)))
    (dsh-listener-record-id listener)))

(defun scoped-tool-key (name session-id)
  (list (runtime-key name) session-id))

(defun ctx-register-tool (context name description parameters handler)
  "Register a session-scoped Tool.

HANDLER receives two arguments: the caller's argument value and the Agent." 
  (require-live-context context)
  (require-string name "tool name")
  (require-string description "tool description")
  (unless (functionp handler)
    (fail 'dsh-validation-error "tool handler must be a function"))
  (let* ((runtime (context-runtime context))
         (run (context-run context))
         (session-id (dsh-run-record-session-id run))
         (key (scoped-tool-key name session-id)))
    (when (gethash key (dsh-runtime-tools runtime))
      (fail 'dsh-tool-error "tool ~S is already registered for session ~S"
            name session-id))
    (let ((tool (%make-tool-record
                 :name (runtime-key name)
                 :description description
                 :parameters parameters
                 :handler handler
                 :session-id session-id
                 :owner-run run)))
      (setf (gethash key (dsh-runtime-tools runtime)) tool)
      (push tool (dsh-run-record-tools run))
      (push-effect run (lambda () (remove-tool-record runtime tool)))
      (dsh-tool-record-name tool))))

(defun ctx-handle (context method handler)
  "Expose one JSON-shaped method to the paired Client half." 
  (require-live-context context)
  (unless (functionp handler)
    (fail 'dsh-validation-error "handler must be a function"))
  (let* ((run (context-run context))
         (key (runtime-key method)))
    (when (gethash key (dsh-run-record-handlers run))
      (fail 'dsh-tool-error "handler ~S is already registered" method))
    (setf (gethash key (dsh-run-record-handlers run)) handler)
    (push-effect run (lambda () (remove-handler run key)))
    key))

(defun ctx-client-handle (context method handler)
  "Expose a method to the paired Client half of the current Package.

Client handlers are kept separate from Host handlers so inspection and
teardown can distinguish the two halves while sharing the same Run lifetime." 
  (require-live-context context)
  (unless (functionp handler)
    (fail 'dsh-validation-error "client handler must be a function"))
  (let* ((run (context-run context))
         (key (runtime-key method)))
    (when (gethash key (dsh-run-record-client-handlers run))
      (fail 'dsh-tool-error "client handler ~S is already registered" method))
    (setf (gethash key (dsh-run-record-client-handlers run)) handler)
    (push-effect run (lambda ()
                       (remhash key (dsh-run-record-client-handlers run))))
    key))
