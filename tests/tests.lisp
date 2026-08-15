(load (merge-pathnames "../load.lisp"
                       (make-pathname :name nil :type nil :defaults *load-truename*)))

(in-package #:dsh-lisp-runtime)

(defvar *test-events* nil)

(defun check (condition message)
  (unless condition
    (error "TEST FAILURE: ~A" message)))

(defun check-equal (expected actual message)
  (check (equal expected actual)
         (format nil "~A; expected ~S, got ~S" message expected actual)))

(defun expect-dsh-error (thunk message)
  (handler-case
      (progn (funcall thunk)
             (error "TEST FAILURE: ~A did not signal" message))
    (dsh-error () t)))

(defun test-waiting-lifecycle-and-disposal ()
  (let* ((runtime (make-runtime))
         (agent (make-agent :runtime runtime :session-id "session-a"))
         (*test-events* nil)
         (definition
           (define-package
            runtime "session-a"
            :id-prefix "demo"
            :name "counter"
            :purpose "exercise the reflective runtime"
            :form
            '(plugin-form (:name "counter" :inject (:clock))
               (ctx-provide ctx "counter-state" (list :value 0))
               (ctx-on ctx "tick"
                       (lambda (payload)
                         (push payload *test-events*)))
               (ctx-register-tool
                ctx "echo"
                "Return the supplied value."
                '(:value)
                (lambda (arguments caller)
                  (list :value (getf arguments :value)
                        :session (agent-session-id caller))))
               (ctx-handle ctx "double"
                            (lambda (arguments)
                              (* 2 (getf arguments :value)))))))
         (plugin-id (getf definition :plugin-id))
         (package-id (getf definition :package-id))
         (waiting (activate-package runtime "session-a" plugin-id package-id)))
    (check-equal :waiting (getf waiting :status)
                 "a hard dependency parks the Package")
    (runtime-provide-service runtime "clock" :clock-value nil)
    (let* ((run-id (getf (getf (inspect-plugin runtime "session-a" plugin-id)
                               :active-run)
                         :plugin-run-id)))
      (check-equal :running (getf (getf (inspect-plugin runtime "session-a" plugin-id)
                                        :active-run)
                                   :status)
                   "the Package activates when its Service appears")
      (runtime-emit runtime "tick" 7)
      (check-equal '(7) *test-events* "the listener receives the Event")
      (check-equal '(:value 9 :session "session-a")
                   (agent-call-tool agent "echo" '(:value 9))
                   "the scoped Tool is callable")
      (check-equal 14
                   (runtime-invoke runtime "session-a" plugin-id run-id "double"
                                   '(:value 7))
                   "the Package handler is callable")
      (stop-plugin runtime "session-a" plugin-id)
      (expect-dsh-error
       (lambda () (agent-call-tool agent "echo" '(:value 1)))
       "stopping removes the Tool")
      (check (null (runtime-get-service runtime "counter-state"))
             "stopping removes the provided Service")
      (check (null (dsh-runtime-listeners runtime))
             "stopping removes the Event listener")
      t)))

(defun test-failed-update-and-rollback ()
  (let* ((runtime (make-runtime))
         (agent (make-agent :runtime runtime :session-id "session-b"))
         (first
           (define-package
            runtime "session-b" :id-prefix "ver"
            :name "version-one" :purpose "stable version"
            :form '(plugin-form (:name "version-one")
                      (ctx-provide ctx "stable" t))))
         (plugin-id (getf first :plugin-id))
         (first-id (getf first :package-id)))
    (declare (ignore agent))
    (check (getf (activate-package runtime "session-b" plugin-id first-id) :ok)
           "the first Package activates")
    (let* ((second
             (define-package
              runtime "session-b" :plugin-id plugin-id
              :name "version-two" :purpose "broken version"
              :form '(error "intentional update failure")))
           (second-id (getf second :package-id))
           (failure (activate-package runtime "session-b" plugin-id second-id
                                      :mode :update))
           (plugin (find-plugin runtime plugin-id)))
      (check (null (getf failure :ok)) "the broken update fails")
      (check-equal first-id (plugin-current-package-id plugin)
                   "the successful current version is retained")
      (check-equal second-id (plugin-next-package-id plugin)
                   "the failed target remains diagnosable")
      (check (null (plugin-active-run plugin))
             "a failed update leaves no half-mounted Run")
      (let ((rollback (rollback-plugin runtime "session-b" plugin-id)))
        (check (getf rollback :ok) "rollback reactivates the prior version")
        (check-equal first-id (plugin-current-package-id plugin)
                     "rollback restores the current version")
        (check (null (plugin-next-package-id plugin))
               "rollback clears the failed target")
        t))))

(defun test-native-self-tools ()
  (let* ((runtime (make-runtime))
         (agent (make-agent :runtime runtime :session-id "session-c")))
    (install-self-tools agent)
    (let ((inspection (agent-call-tool agent "dsh/inspect" nil)))
      (check (find "dsh/inspect" (getf inspection :tools)
                  :key (lambda (entry) (getf entry :name))
                  :test #'equal)
             "self inspection is exposed as a native Tool"))
    (let* ((defined
             (agent-call-tool
              agent "dsh/define"
              (list :id-prefix "self"
                    :name "self-package"
                    :purpose "defined through the runtime Tool"
                    :form '(plugin-form (:name "self-package")
                              (ctx-provide ctx "self-service" t)))))
           (plugin-id (getf defined :plugin-id))
           (package-id (getf defined :package-id)))
      (check (getf (agent-call-tool
                    agent "dsh/run"
                    (list :plugin-id plugin-id :package-id package-id))
                   :ok)
             "the native run Tool activates a Package")
      (check (getf (agent-call-tool agent "dsh/rollback" (list :plugin-id plugin-id))
                  :ok)
             "the native rollback Tool reactivates the successful Package")
      (check (getf (agent-call-tool agent "dsh/stop" (list :plugin-id plugin-id))
                   :ok)
             "the native stop Tool disposes a Package")
       t)))

(defun test-client-half-lifecycle ()
  (let* ((runtime (make-runtime))
         (definition
           (define-package
            runtime "session-client" :id-prefix "cli"
            :name "client-surface" :purpose "exercise the paired Client half"
            :form '(plugin-form (:name "client-surface")
                      (ctx-client-handle
                       ctx "render"
                       (lambda (arguments)
                         (list :rendered (getf arguments :text)))))))
         (plugin-id (getf definition :plugin-id))
         (package-id (getf definition :package-id)))
    (activate-package runtime "session-client" plugin-id package-id)
    (let* ((inspection (inspect-plugin runtime "session-client" plugin-id))
           (run (getf inspection :active-run))
           (summary (first (getf inspection :packages))))
      (check (find "render" (getf run :client-handlers) :test #'string=)
             "active Package exposes its Client handler")
      (check (getf summary :has-client-half)
             "Package inspection reports a Client half")
      (check-equal '(:rendered "ok")
                   (runtime-invoke-client runtime "session-client" plugin-id
                                           (getf run :plugin-run-id) "render"
                                           '(:text "ok"))
                   "Client handler is callable through the paired runtime"))
    (stop-plugin runtime "session-client" plugin-id)
    (expect-dsh-error
     (lambda ()
       (runtime-invoke-client runtime "session-client" plugin-id "run-1"
                              "render" '(:text "stale")))
     "stopping disposes the Client half")
    t))

(defun test-jsonrpc-lifecycle-bridge ()
  (let* ((server (make-jsonrpc-server))
         (defined
           (dsh-jsonrpc-dispatch
            server
            '(:jsonrpc "2.0" :id 1 :method "cordis/define"
              :params (:session-id "session-rpc" :id-prefix "rpc"
                       :name "waiting" :purpose "bridge lifecycle"
                       :form "(list :name \"waiting\" :inject '(\"clock\") :apply (lambda (ctx) (declare (ignore ctx))))"))))
         (definition (getf defined :result))
         (plugin-id (getf definition :plugin-id))
         (package-id (getf definition :package-id))
         (waiting
           (dsh-jsonrpc-dispatch
            server
            (list :jsonrpc "2.0" :id 2 :method "cordis/run"
                  :params (list :session-id "session-rpc" :plugin-id plugin-id
                                :package-id package-id :mode "run"))))
         (stale-stop
           (dsh-jsonrpc-dispatch
            server
            '(:jsonrpc "2.0" :id 3 :method "cordis/stop"
              :params (:session-id "session-rpc" :plugin-id "missing"))))
         (removed
           (dsh-jsonrpc-dispatch
            server
            (list :jsonrpc "2.0" :id 4 :method "cordis/undefine"
                  :params (list :session-id "session-rpc" :plugin-id plugin-id)))))
    (check (getf definition :ok) "the bridge defines a Package")
    (check-equal :waiting (getf (getf waiting :result) :status)
                 "the bridge preserves a waiting activation")
    (check-equal '("clock") (getf (getf waiting :result) :waiting-for)
                 "the bridge exposes missing services")
    (check-equal 3 (getf stale-stop :id)
                 "the bridge retains the JSON-RPC request id on errors")
    (check (getf stale-stop :error) "the bridge reports an RPC error")
    (check (getf (getf removed :result) :was-running)
           "undefine reports its stopped active Run")
    t))

(defun run-tests ()
  (dolist (test '(test-waiting-lifecycle-and-disposal
                  test-failed-update-and-rollback
                  test-native-self-tools
                  test-client-half-lifecycle
                  test-jsonrpc-lifecycle-bridge))
    (format t "[TEST] ~A~%" test)
    (funcall test))
  (format t "All dsh-lisp-runtime tests passed.~%")
  t)

(run-tests)
