(load (merge-pathnames "../load.lisp"
                       (make-pathname :name nil :type nil :defaults *load-truename*)))

(in-package #:dsh-lisp-runtime)

(let* ((runtime (make-runtime))
       (agent (make-agent :runtime runtime :session-id "example-session"))
       (defined
         (define-package
          runtime "example-session"
          :id-prefix "clk"
          :name "clock"
          :purpose "provide a time tool"
          :form
          '(plugin-form (:name "clock")
             (ctx-provide ctx "clock" (lambda () (get-universal-time)))
             (ctx-register-tool
              ctx "clock/now"
              "Return the current universal time."
              nil
              (lambda (arguments caller)
                (declare (ignore arguments caller))
                 (funcall (ctx-get ctx "clock")))))))
       (plugin-id (getf defined :plugin-id))
       (package-id (getf defined :package-id)))
  (install-self-tools agent)
  (format t "Defined: ~A/~A~%" plugin-id package-id)
  (format t "Run: ~S~%"
          (activate-package runtime "example-session" plugin-id package-id))
  (format t "Tool result: ~S~%"
          (agent-call-tool agent "clock/now" nil))
  (format t "Inspect: ~S~%" (agent-inspect agent))
  (stop-plugin runtime "example-session" plugin-id)
  (format t "Stopped: ~S~%" (agent-inspect agent)))
