(require :asdf)

(let ((root (truename (merge-pathnames "../"
                                      (make-pathname :name nil :type nil
                                                     :defaults *load-truename*)))))
  (push root asdf:*central-registry*)
  (asdf:load-system "dsh-lisp-runtime")
  (format t "ASDF loaded dsh-lisp-runtime from ~A~%" root))
