ALTER TABLE email_approval_queue
  DROP CONSTRAINT IF EXISTS email_approval_queue_approval_request_id_key;

ALTER TABLE email_approval_queue
  DROP CONSTRAINT IF EXISTS email_approval_queue_request_stage_key;

ALTER TABLE email_approval_queue
  ADD CONSTRAINT email_approval_queue_request_stage_approver_key
  UNIQUE (approval_request_id, current_stage, approver_user_id);
