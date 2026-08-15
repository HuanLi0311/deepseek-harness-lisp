(asdf:defsystem "dsh-lisp-runtime"
  :description "A Common Lisp self-reflective runtime modeled after DSH dynamic Cordis packages."
  :version "0.1.0"
  :author "DeepSeek Harness Lisp port"
  :license "MIT"
  :serial t
  :components ((:file "src/package")
               (:file "src/conditions")
               (:file "src/model")
               (:file "src/runtime")
               (:file "src/context")
               (:file "src/reflection")
               (:file "src/tools")
               (:file "src/jsonrpc")))
