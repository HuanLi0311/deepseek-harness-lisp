(in-package #:dsh-lisp-runtime)

(define-condition dsh-error (error)
  ((message
    :initarg :message
    :reader dsh-error-message))
  (:report (lambda (condition stream)
             (write-string (dsh-error-message condition) stream))))

(define-condition dsh-validation-error (dsh-error) ())
(define-condition dsh-plugin-not-found (dsh-error) ())
(define-condition dsh-package-not-found (dsh-error) ())
(define-condition dsh-activation-error (dsh-error) ())
(define-condition dsh-service-error (dsh-error) ())
(define-condition dsh-tool-error (dsh-error) ())

(defparameter *dsh-missing* (gensym "DSH-MISSING-"))

(defun fail (condition-type format-control &rest format-arguments)
  (error condition-type
         :message (apply #'format nil format-control format-arguments)))

(defun require-string (value field)
  (unless (stringp value)
    (fail 'dsh-validation-error "~A must be a string" field))
  value)

(defun normalized-name (value)
  (string-downcase (string value)))

(defun copy-form (form)
  "Copy the cons structure of a stored package form for inspection." 
  (if (consp form) (copy-tree form) form))

(defun plist-present-p (plist key)
  (not (eq (getf plist key *dsh-missing*) *dsh-missing*)))
