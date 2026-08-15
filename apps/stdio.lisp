(load (merge-pathnames "../load.lisp"
                       (make-pathname :name nil :type nil :defaults *load-truename*)))

(dsh-lisp-runtime:serve-jsonrpc
 (dsh-lisp-runtime:make-jsonrpc-server))
