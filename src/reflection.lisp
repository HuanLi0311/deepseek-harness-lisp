(in-package #:dsh-lisp-runtime)

(defun sorted-hash-keys (hash-table)
  (sort (loop for key being the hash-keys of hash-table collect key)
        #'string< :key #'princ-to-string))

(defun run-inspection (run)
  (when run
    (list :plugin-run-id (dsh-run-record-id run)
          :package-id (dsh-run-record-package-id run)
          :status (dsh-run-record-status run)
          :provides (copy-list (dsh-run-record-provided-services run))
          :handlers (sort (loop for key being the hash-keys of (dsh-run-record-handlers run)
                                collect key)
                          #'string<)
          :client-handlers
          (sort (loop for key being the hash-keys
                                      of (dsh-run-record-client-handlers run)
                      collect key)
                #'string<)
          :tools (sort (mapcar #'dsh-tool-record-name
                               (dsh-run-record-tools run))
                       #'string<)
          :error (dsh-run-record-error run))))

(defun inspect-package-summary (plugin record)
  (let* ((run (and plugin (dsh-plugin-record-active-run plugin)))
         (client-half
           (and run
                (equal (dsh-package-record-id record)
                       (dsh-run-record-package-id run))
                (plusp (hash-table-count
                        (dsh-run-record-client-handlers run))))))
    (list :package-id (dsh-package-record-id record)
          :name (dsh-package-record-name record)
          :purpose (dsh-package-record-purpose record)
          :has-host-half t
          :has-client-half (and client-half t))))

(defun inspect-plugin (runtime session-id plugin-id)
  "Return source-free metadata for a Plugin and all Package summaries." 
  (let ((plugin (require-owned-plugin runtime session-id plugin-id)))
    (list :mode :plugin
          :plugin-id (dsh-plugin-record-id plugin)
          :session-id (dsh-plugin-record-session-id plugin)
          :current-package-id (dsh-plugin-record-current-package-id plugin)
          :next-package-id (dsh-plugin-record-next-package-id plugin)
          :active-run (run-inspection (dsh-plugin-record-active-run plugin))
          :latest-run (run-inspection (dsh-plugin-record-latest-run plugin))
          :packages
          (mapcar (lambda (package-id)
                    (inspect-package-summary
                     plugin
                     (gethash package-id (dsh-plugin-record-packages plugin))))
                  (dsh-plugin-record-package-order plugin)))))

(defun inspect-package (runtime session-id plugin-id package-id)
  "Return exact immutable Package metadata and its stored Lisp form." 
  (let* ((plugin (require-owned-plugin runtime session-id plugin-id))
         (record (require-package-record runtime plugin-id package-id)))
    (list :mode :package
          :plugin-id (dsh-plugin-record-id plugin)
          :package-id (dsh-package-record-id record)
          :name (dsh-package-record-name record)
          :purpose (dsh-package-record-purpose record)
          :current-package-id (dsh-plugin-record-current-package-id plugin)
          :next-package-id (dsh-plugin-record-next-package-id plugin)
          :code (copy-form (dsh-package-record-form record))
          :runtime (run-inspection
                    (and (dsh-plugin-record-active-run plugin)
                         (equal package-id
                                (dsh-run-record-package-id
                                 (dsh-plugin-record-active-run plugin)))
                         (dsh-plugin-record-active-run plugin))))))

(defun inspect-runtime (runtime &key session-id)
  "Inspect the live runtime without exposing service values or closures." 
  (let ((plugins nil))
    (dolist (plugin-id (dsh-runtime-plugin-order runtime))
      (let ((plugin (find-plugin runtime plugin-id)))
        (when (and plugin
                   (or (null session-id)
                       (equal session-id (dsh-plugin-record-session-id plugin))))
          (push (list :plugin-id plugin-id
                      :session-id (dsh-plugin-record-session-id plugin)
                      :current-package-id (dsh-plugin-record-current-package-id plugin)
                      :next-package-id (dsh-plugin-record-next-package-id plugin)
                      :active-run (run-inspection
                                   (dsh-plugin-record-active-run plugin)))
                plugins))))
    (list :services
          (sort
           (loop for key in (sorted-hash-keys (dsh-runtime-services runtime))
                 for record = (gethash key (dsh-runtime-services runtime))
                 collect (list :name key
                               :owner-run (and (dsh-service-record-owner-run record)
                                               (dsh-run-record-id
                                                (dsh-service-record-owner-run record)))))
           #'string< :key (lambda (entry) (getf entry :name)))
          :events
          (remove-duplicates
           (mapcar (lambda (entry) (getf entry :event))
                   (reverse (dsh-runtime-event-history runtime)))
           :test #'equal)
          :tools
          (sort
           (loop for key being the hash-keys of (dsh-runtime-tools runtime)
                 for tool = (gethash key (dsh-runtime-tools runtime))
                 when (or (null session-id)
                          (equal session-id (dsh-tool-record-session-id tool)))
                  collect (list :name (dsh-tool-record-name tool)
                                :description (dsh-tool-record-description tool)
                                :parameters (dsh-tool-record-parameters tool)
                                :session-id (dsh-tool-record-session-id tool)))
           #'string< :key (lambda (entry) (getf entry :name)))
          :plugins (nreverse plugins))))

(defun agent-inspect (agent)
  (inspect-runtime (agent-runtime agent)
                   :session-id (agent-session-id agent)))
