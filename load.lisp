(defparameter *dsh-lisp-runtime-root*
  (make-pathname :name nil :type nil :defaults *load-truename*))

(dolist (source '("src/package.lisp"
                  "src/conditions.lisp"
                  "src/model.lisp"
                  "src/runtime.lisp"
                  "src/context.lisp"
                  "src/reflection.lisp"
                  "src/tools.lisp"
                  "src/jsonrpc.lisp"))
  (load (merge-pathnames source *dsh-lisp-runtime-root*)))

(format *error-output* "Loaded dsh-lisp-runtime from ~A~%" *dsh-lisp-runtime-root*)
