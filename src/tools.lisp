(in-package #:dsh-lisp-runtime)

(defun register-builtin-tool (agent name description parameters handler)
  (let* ((runtime (agent-runtime agent))
         (session-id (agent-session-id agent))
         (key (scoped-tool-key name session-id)))
    (unless (gethash key (dsh-runtime-tools runtime))
      (setf (gethash key (dsh-runtime-tools runtime))
            (%make-tool-record
             :name (runtime-key name)
             :description description
             :parameters parameters
             :handler handler
             :session-id session-id
             :owner-run nil)))
    (gethash key (dsh-runtime-tools runtime))))

(defun remove-builtin-tool (agent name)
  "Remove a Tool installed outside a Package Run.

Package-owned Tools are deliberately left alone; their Run disposer owns them." 
  (let* ((runtime (agent-runtime agent))
         (key (scoped-tool-key name (agent-session-id agent)))
         (tool (gethash key (dsh-runtime-tools runtime))))
    (when (and tool (null (dsh-tool-record-owner-run tool)))
      (remhash key (dsh-runtime-tools runtime))
      t)))

(defun runtime-tools-for (runtime session-id)
  (sort
   (loop for key being the hash-keys of (dsh-runtime-tools runtime)
         for tool = (gethash key (dsh-runtime-tools runtime))
         when (equal session-id (dsh-tool-record-session-id tool))
         collect tool)
   #'string< :key #'dsh-tool-record-name))

(defun runtime-call-tool (runtime session-id name arguments &optional agent)
  "Call a Tool visible to SESSION-ID through its owning Agent." 
  (let* ((key (scoped-tool-key name session-id))
         (tool (gethash key (dsh-runtime-tools runtime))))
    (unless tool
      (fail 'dsh-tool-error "tool ~S is not visible to session ~S"
            name session-id))
    (handler-case
        (funcall (dsh-tool-record-handler tool) arguments agent)
      (dsh-error (condition)
        (error condition))
      (error (condition)
        (fail 'dsh-tool-error "tool ~S failed: ~A"
              name condition)))))

(defun agent-call-tool (agent name arguments)
  (runtime-call-tool (agent-runtime agent)
                     (agent-session-id agent)
                     name
                     arguments
                     agent))

(defun runtime-invoke (runtime session-id plugin-id run-id method arguments)
  "Invoke a method registered by one active Package Run." 
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (run (dsh-plugin-record-active-run plugin)))
    (unless (and run (equal run-id (dsh-run-record-id run)))
      (fail 'dsh-tool-error "plugin ~S is not running activation ~S"
            plugin-id run-id))
    (let ((handler (gethash (runtime-key method)
                            (dsh-run-record-handlers run))))
      (unless handler
        (fail 'dsh-tool-error "method ~S is not registered by run ~S"
              method run-id))
      (handler-case
          (funcall handler arguments)
        (error (condition)
          (fail 'dsh-tool-error "method ~S failed: ~A" method condition))))))

(defun runtime-invoke-client (runtime session-id plugin-id run-id method arguments)
  "Invoke a method registered by the Client half of an active Package Run." 
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (run (dsh-plugin-record-active-run plugin)))
    (unless (and run (equal run-id (dsh-run-record-id run)))
      (fail 'dsh-tool-error "plugin ~S is not running activation ~S"
            plugin-id run-id))
    (let ((handler (gethash (runtime-key method)
                            (dsh-run-record-client-handlers run))))
      (unless handler
        (fail 'dsh-tool-error "client method ~S is not registered by run ~S"
              method run-id))
      (handler-case
          (funcall handler arguments)
        (error (condition)
          (fail 'dsh-tool-error "client method ~S failed: ~A" method condition))))))

(defun install-self-tools (agent)
  "Install the Agent's native self-reflection and Package lifecycle tools." 
  (let ((runtime (agent-runtime agent))
        (session-id (agent-session-id agent)))
    (register-builtin-tool
     agent "dsh/inspect"
     "Inspect the current Agent-scoped Lisp runtime."
     nil
     (lambda (arguments caller)
       (declare (ignore arguments caller))
       (agent-inspect agent)))
    (register-builtin-tool
     agent "dsh/define"
     "Record an immutable Lisp Package."
     '(:plugin-id :id-prefix :name :purpose :form)
     (lambda (arguments caller)
       (declare (ignore caller))
       (apply #'define-package runtime session-id
              (list :plugin-id (getf arguments :plugin-id)
                    :id-prefix (getf arguments :id-prefix)
                    :name (getf arguments :name)
                    :purpose (getf arguments :purpose)
                    :form (getf arguments :form)))))
    (register-builtin-tool
     agent "dsh/run"
     "Activate an exact Lisp Package, or re-activate the current version."
     '(:plugin-id :package-id :mode)
     (lambda (arguments caller)
       (declare (ignore caller))
       (activate-package runtime session-id
                         (getf arguments :plugin-id)
                         (getf arguments :package-id)
                         :mode (or (getf arguments :mode) :run))))
    (register-builtin-tool
     agent "dsh/stop"
     "Stop a Plugin while retaining its immutable Package versions."
     '(:plugin-id)
     (lambda (arguments caller)
       (declare (ignore caller))
       (stop-plugin runtime session-id (getf arguments :plugin-id))))
    (register-builtin-tool
     agent "dsh/undefine"
     "Permanently remove a Plugin and all its Package versions."
     '(:plugin-id)
     (lambda (arguments caller)
       (declare (ignore caller))
       (undefine-plugin runtime session-id (getf arguments :plugin-id))))
    (list :ok t
          :session-id session-id
          :tools (mapcar #'dsh-tool-record-name
                         (runtime-tools-for runtime session-id)))))
