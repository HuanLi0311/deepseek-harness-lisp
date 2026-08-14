(in-package #:dsh-lisp-runtime)

(defstruct (dsh-package-record
            (:constructor %make-package-record))
  id
  session-id
  plugin-id
  name
  purpose
  form
  created-at)

(defstruct (dsh-plugin-record
            (:constructor %make-plugin-record))
  id
  session-id
  (packages (make-hash-table :test #'equal))
  (package-order nil)
  current-package-id
  next-package-id
  active-run
  latest-run)

(defstruct (dsh-run-record
            (:constructor %make-run-record))
  id
  plugin-id
  package-id
  session-id
  (status :starting)
  descriptor
  (effects nil)
  (listeners nil)
  (tools nil)
  (handlers (make-hash-table :test #'equal))
  (client-handlers (make-hash-table :test #'equal))
  (provided-services nil)
  error
  started-at
  stopped-at)

(defstruct (dsh-service-record
            (:constructor %make-service-record))
  name
  value
  owner-run)

(defstruct (dsh-listener-record
            (:constructor %make-listener-record))
  id
  event
  handler
  owner-run)

(defstruct (dsh-tool-record
            (:constructor %make-tool-record))
  name
  description
  parameters
  handler
  session-id
  owner-run)

(defstruct (dsh-context
            (:constructor %make-context))
  runtime
  run
  agent)

(defstruct (dsh-runtime
            (:constructor %make-runtime-record))
  (plugins (make-hash-table :test #'equal))
  (plugin-order nil)
  (services (make-hash-table :test #'equal))
  (listeners nil)
  (tools (make-hash-table :test #'equal))
  (agents (make-hash-table :test #'equal))
  (next-plugin 1)
  (next-package 1)
  (next-run 1)
  (next-listener 1)
  (event-history nil))

(defstruct (dsh-agent
            (:constructor %make-agent))
  runtime
  session-id)

(defun now-marker ()
  "Return a portable, monotonic-enough marker for diagnostics." 
  (get-universal-time))
