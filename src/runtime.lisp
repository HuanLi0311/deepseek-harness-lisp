(in-package #:dsh-lisp-runtime)

(defun make-runtime ()
  "Create an empty self-reflective runtime." 
  (%make-runtime-record))

(defun make-agent (&key (runtime (make-runtime)) session-id)
  "Create an Agent view with a session-scoped capability boundary." 
  (require-string session-id "session-id")
  (let ((agent (%make-agent :runtime runtime :session-id session-id)))
    (setf (gethash session-id (dsh-runtime-agents runtime)) agent)
    agent))

(defun agent-runtime (agent)
  (dsh-agent-runtime agent))

(defun agent-session-id (agent)
  (dsh-agent-session-id agent))

(defun runtime-key (name)
  (normalized-name (require-string name "name")))

(defun next-id (runtime slot prefix)
  (let ((value (ecase slot
                 (next-plugin (dsh-runtime-next-plugin runtime))
                 (next-package (dsh-runtime-next-package runtime))
                 (next-run (dsh-runtime-next-run runtime))
                 (next-listener (dsh-runtime-next-listener runtime)))))
    (ecase slot
      (next-plugin (incf (dsh-runtime-next-plugin runtime)))
      (next-package (incf (dsh-runtime-next-package runtime)))
      (next-run (incf (dsh-runtime-next-run runtime)))
      (next-listener (incf (dsh-runtime-next-listener runtime))))
    (format nil "~A-~D" prefix value)))

(defun valid-prefix-p (value)
  (and (stringp value)
       (<= 3 (length value) 6)
       (every (lambda (character)
                (and (char>= character #\a)
                     (char<= character #\z)))
              value)))

(defun make-plugin-id (runtime prefix)
  (unless (valid-prefix-p prefix)
    (fail 'dsh-validation-error
          "id-prefix must contain 3 to 6 lowercase ASCII letters"))
  (loop for id = (next-id runtime 'next-plugin prefix)
        unless (gethash id (dsh-runtime-plugins runtime))
          return id))

(defun make-package-id (runtime)
  (next-id runtime 'next-package "pkg"))

(defun make-run-id (runtime)
  (next-id runtime 'next-run "run"))

(defun find-plugin (runtime plugin-id)
  (gethash (require-string plugin-id "plugin-id")
           (dsh-runtime-plugins runtime)))

(defun require-plugin (runtime plugin-id)
  (or (find-plugin runtime plugin-id)
      (fail 'dsh-plugin-not-found "dynamic plugin ~S does not exist" plugin-id)))

(defun require-owned-plugin (runtime session-id plugin-id)
  (let ((plugin (require-plugin runtime plugin-id)))
    (unless (equal session-id (dsh-plugin-record-session-id plugin))
      (fail 'dsh-plugin-not-found
            "dynamic plugin ~S is not owned by session ~S"
            plugin-id session-id))
    plugin))

(defun find-package-record (runtime plugin-id package-id)
  (let ((plugin (find-plugin runtime plugin-id)))
    (and plugin
         (gethash (require-string package-id "package-id")
                  (dsh-plugin-record-packages plugin)))))

(defun require-package-record (runtime plugin-id package-id)
  (or (find-package-record runtime plugin-id package-id)
      (fail 'dsh-package-not-found
            "package ~S does not exist under plugin ~S"
            package-id plugin-id)))

(defun plugin-id (plugin)
  (dsh-plugin-record-id plugin))

(defun package-id (package-record)
  (dsh-package-record-id package-record))

(defun package-form (package-record)
  (dsh-package-record-form package-record))

(defun context-symbol-in (form)
  (cond
    ((and (symbolp form)
          (string= (symbol-name form) "CTX"))
     form)
    ((consp form)
     (or (context-symbol-in (car form))
         (context-symbol-in (cdr form))))))

(defmacro plugin-form ((&key name inject) &body body)
  "Build a stored Package form with a Cordis-like descriptor shape.

The context variable is taken from the caller's body so a stored form remains
valid when it is read in a different Lisp package." 
  (let ((context (or (some #'context-symbol-in body)
                     (gensym "CTX"))))
    `(list :name ,name
           :inject ',inject
           :apply (lambda (,context) ,@body))))

(defun plugin-current-package-id (plugin)
  (dsh-plugin-record-current-package-id plugin))

(defun plugin-next-package-id (plugin)
  (dsh-plugin-record-next-package-id plugin))

(defun plugin-active-run (plugin)
  (dsh-plugin-record-active-run plugin))

(defun validate-package-form (form)
  (unless (or (functionp form) (consp form))
    (fail 'dsh-validation-error
          "package form must be a function or a non-empty Lisp form"))
  form)

(defun define-package (runtime session-id &key plugin-id id-prefix name purpose form)
  "Record one immutable Lisp Package without activating it.

FORM is data until activate-package evaluates it. A normal form evaluates to a
plugin descriptor plist containing :NAME, :INJECT, and :APPLY." 
  (require-string session-id "session-id")
  (require-string name "name")
  (require-string purpose "purpose")
  (validate-package-form form)
  (let* ((plugins (dsh-runtime-plugins runtime))
         (plugin (if plugin-id
                     (require-owned-plugin runtime session-id plugin-id)
                     (let ((created (%make-plugin-record
                                     :id (make-plugin-id runtime (or id-prefix "dsh"))
                                     :session-id session-id)))
                       (setf (gethash (dsh-plugin-record-id created) plugins) created)
                       (setf (dsh-runtime-plugin-order runtime)
                             (append (dsh-runtime-plugin-order runtime)
                                     (list (dsh-plugin-record-id created))))
                       created)))
         (package-id (make-package-id runtime))
         (record (%make-package-record
                  :id package-id
                  :session-id session-id
                  :plugin-id (dsh-plugin-record-id plugin)
                  :name name
                  :purpose purpose
                  :form (copy-form form)
                  :created-at (now-marker))))
    (setf (gethash package-id (dsh-plugin-record-packages plugin)) record)
    (setf (dsh-plugin-record-package-order plugin)
          (append (dsh-plugin-record-package-order plugin) (list package-id)))
    (list :ok t
          :plugin-id (dsh-plugin-record-id plugin)
          :package-id package-id
          :name name
          :purpose purpose
          :has-host-half t
          :has-client-half nil)))

(defun evaluate-package-form (package-record)
  (handler-case
      (let ((value (if (functionp (dsh-package-record-form package-record))
                       (funcall (dsh-package-record-form package-record))
                       (eval (dsh-package-record-form package-record)))))
        (unless (listp value)
          (fail 'dsh-activation-error
                "package ~S evaluated to ~S, not a descriptor plist"
                (dsh-package-record-id package-record) value))
        value)
    (dsh-error (condition)
      (error condition))
    (error (condition)
      (fail 'dsh-activation-error
            "package ~S evaluation failed: ~A"
            (dsh-package-record-id package-record) condition))))

(defun descriptor-injections (descriptor)
  (let ((inject (getf descriptor :inject nil)))
    (unless (listp inject)
      (fail 'dsh-validation-error ":inject must be a list of service names"))
    (mapcar (lambda (name) (runtime-key (string name))) inject)))

(defun descriptor-apply (descriptor)
  (let ((apply-function (getf descriptor :apply nil)))
    (unless (functionp apply-function)
      (fail 'dsh-validation-error ":apply must be a function"))
    apply-function))

(defun descriptor-name (descriptor package-record)
  (let ((name (getf descriptor :name (dsh-package-record-name package-record))))
    (require-string name ":name")))

(defun missing-services (runtime names)
  (remove-if (lambda (name)
               (gethash name (dsh-runtime-services runtime)))
             names))

(defun activation-receipt (plugin run)
  (list :ok t
        :status (dsh-run-record-status run)
        :plugin-id (dsh-plugin-record-id plugin)
        :package-id (dsh-run-record-package-id run)
        :plugin-run-id (dsh-run-record-id run)
        :current-package-id (dsh-plugin-record-current-package-id plugin)
        :next-package-id (dsh-plugin-record-next-package-id plugin)))

(defun condition-message (condition)
  (if (typep condition 'dsh-error)
      (dsh-error-message condition)
      (princ-to-string condition)))

(defun remove-listener-record (runtime listener)
  (setf (dsh-runtime-listeners runtime)
        (delete listener (dsh-runtime-listeners runtime) :test #'eq)))

(defun remove-tool-record (runtime tool)
  (let* ((name (dsh-tool-record-name tool))
         (session-id (dsh-tool-record-session-id tool))
         (key (list name session-id)))
    (when (eq (gethash key (dsh-runtime-tools runtime)) tool)
      (remhash key (dsh-runtime-tools runtime)))))

(defun remove-handler (run method)
  (remhash (runtime-key method) (dsh-run-record-handlers run)))

(defun remove-owned-service (runtime name run)
  (let* ((key (runtime-key name))
         (record (gethash key (dsh-runtime-services runtime))))
    (when (and record (eq (dsh-service-record-owner-run record) run))
      (remhash key (dsh-runtime-services runtime)))))

(defun dispose-run (runtime run)
  "Dispose all effects in reverse registration order.

Disposers are deliberately owned by the Run. This is the lifecycle equivalent
of Cordis Fiber disposal: a failed or stopped Package cannot leave its tools,
listeners, services, or handlers installed." 
  (declare (ignore runtime))
  (unless (eq (dsh-run-record-status run) :stopped)
    (dolist (effect (dsh-run-record-effects run))
      (handler-case
          (funcall effect)
        (error (condition)
          (push (format nil "disposer failed: ~A" condition)
                (dsh-run-record-error run)))))
    (setf (dsh-run-record-effects run) nil
          (dsh-run-record-listeners run) nil
          (dsh-run-record-tools run) nil
          (dsh-run-record-provided-services run) nil
          (dsh-run-record-stopped-at run) (now-marker)
          (dsh-run-record-status run) :stopped)))

(defun fail-run (runtime plugin run condition)
  (setf (dsh-run-record-error run) (condition-message condition))
  (dispose-run runtime run)
  (setf (dsh-run-record-status run) :failed)
  (when (eq (dsh-plugin-record-active-run plugin) run)
    (setf (dsh-plugin-record-active-run plugin) nil))
  (list :ok nil
        :reason :activation-failed
        :message (dsh-run-record-error run)
        :plugin-id (dsh-plugin-record-id plugin)
        :package-id (dsh-run-record-package-id run)
        :plugin-run-id (dsh-run-record-id run)))

(defun start-run-record (runtime plugin package run)
  (handler-case
      (let* ((descriptor (or (dsh-run-record-descriptor run)
                             (evaluate-package-form package)))
             (inject (descriptor-injections descriptor))
             (missing (missing-services runtime inject)))
        (setf (dsh-run-record-descriptor run) descriptor)
        (if missing
            (progn
              (setf (dsh-run-record-status run) :waiting)
              (activation-receipt plugin run))
            (let ((context
                    (%make-context
                     :runtime runtime
                     :run run
                     :agent (gethash (dsh-run-record-session-id run)
                                     (dsh-runtime-agents runtime)))))
              (setf (dsh-run-record-status run) :starting)
              (funcall (descriptor-apply descriptor) context)
              (setf (dsh-run-record-status run) :running
                    (dsh-plugin-record-current-package-id plugin)
                    (dsh-run-record-package-id run)
                    (dsh-plugin-record-next-package-id plugin) nil)
              (activation-receipt plugin run))))
    (error (condition)
      (fail-run runtime plugin run condition))))

(defun retry-waiting-runs (runtime)
  (dolist (plugin-id (dsh-runtime-plugin-order runtime))
    (let ((plugin (find-plugin runtime plugin-id)))
      (when plugin
        (let ((run (dsh-plugin-record-active-run plugin)))
          (when (and run (eq (dsh-run-record-status run) :waiting))
            (let ((package (find-package-record
                            runtime plugin-id (dsh-run-record-package-id run))))
              (when package
                (let ((receipt (start-run-record runtime plugin package run)))
                  (when (and (listp receipt) (getf receipt :ok))
                    (setf (dsh-plugin-record-latest-run plugin) run)))))))))))

(declaim (ftype function stop-plugin))

(defun runtime-provide-service (runtime name value &optional owner-run)
  (let ((key (runtime-key name)))
    (when (gethash key (dsh-runtime-services runtime))
      (fail 'dsh-service-error "service ~S is already provided" key))
    (setf (gethash key (dsh-runtime-services runtime))
          (%make-service-record :name key :value value :owner-run owner-run))
    (when owner-run
      (push key (dsh-run-record-provided-services owner-run)))
    (retry-waiting-runs runtime)
    value))

(defun runtime-remove-service (runtime name &optional owner-run)
  (let* ((key (runtime-key name))
         (record (gethash key (dsh-runtime-services runtime))))
    (when (and record (or (null owner-run)
                          (eq owner-run (dsh-service-record-owner-run record))))
      (remhash key (dsh-runtime-services runtime)))))

(defun runtime-get-service (runtime name)
  (let ((record (gethash (runtime-key name) (dsh-runtime-services runtime))))
    (and record (dsh-service-record-value record))))

(defun runtime-service-present-p (runtime name)
  (not (null (gethash (runtime-key name) (dsh-runtime-services runtime)))))

(defun runtime-emit (runtime event payload)
  "Emit EVENT to a stable snapshot of listeners in registration order." 
  (let ((key (runtime-key event))
        (results nil))
    (push (list :event key :payload payload :at (now-marker))
          (dsh-runtime-event-history runtime))
    (dolist (listener (copy-list (dsh-runtime-listeners runtime)))
      (when (equal key (dsh-listener-record-event listener))
        (push (funcall (dsh-listener-record-handler listener) payload)
              results)))
    (nreverse results)))

(defun activate-package (runtime session-id plugin-id package-id &key (mode :run))
  "Activate a Package using :RUN for start/restart/rollback or :UPDATE.

An update first disposes the current Run. If the target fails, the old
CURRENT-PACKAGE-ID remains recorded and the caller can invoke rollback-plugin.
The old Run is not silently restarted, matching DSH's explicit recovery rule." 
  (unless (member mode '(:run :update))
    (fail 'dsh-validation-error "mode must be :run or :update"))
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (package (require-package-record runtime plugin-id package-id))
         (current (dsh-plugin-record-current-package-id plugin)))
    (when (and (eq mode :update) (null current))
      (fail 'dsh-validation-error
            "plugin ~S has no current package; use :run for first activation"
            plugin-id))
    (when (dsh-plugin-record-active-run plugin)
      (stop-plugin runtime session-id plugin-id))
    (let ((run (%make-run-record
                :id (make-run-id runtime)
                :plugin-id plugin-id
                :package-id package-id
                :session-id session-id
                :started-at (now-marker))))
      (setf (dsh-plugin-record-next-package-id plugin) package-id
            (dsh-plugin-record-active-run plugin) run
            (dsh-plugin-record-latest-run plugin) run)
      (start-run-record runtime plugin package run))))

(defun stop-plugin (runtime session-id plugin-id)
  "Stop a Plugin and dispose its current Run while retaining all versions." 
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (run (dsh-plugin-record-active-run plugin)))
    (when run
      (dispose-run runtime run)
      (setf (dsh-run-record-status run) :stopped
            (dsh-plugin-record-active-run plugin) nil
            (dsh-plugin-record-latest-run plugin) run))
    (list :ok t
          :plugin-id plugin-id
          :status :stopped
          :current-package-id (dsh-plugin-record-current-package-id plugin)
          :next-package-id (dsh-plugin-record-next-package-id plugin))))

(defun rollback-plugin (runtime session-id plugin-id)
  "Re-activate the last successful Package explicitly." 
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (current (dsh-plugin-record-current-package-id plugin)))
    (unless current
      (fail 'dsh-validation-error
            "plugin ~S has no successful package to roll back to" plugin-id))
    (activate-package runtime session-id plugin-id current :mode :run)))

(defun undefine-plugin (runtime session-id plugin-id)
  "Stop and permanently remove a Plugin and every immutable Package." 
  (let ((plugin (require-owned-plugin runtime session-id plugin-id)))
    (when (dsh-plugin-record-active-run plugin)
      (stop-plugin runtime session-id plugin-id))
    (remhash plugin-id (dsh-runtime-plugins runtime))
    (setf (dsh-runtime-plugin-order runtime)
          (delete plugin-id (dsh-runtime-plugin-order runtime) :test #'equal))
    (list :ok t :plugin-id plugin-id)))
