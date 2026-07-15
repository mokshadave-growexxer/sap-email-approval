import { query } from '../../db.js';

export class PostgresQueueStore {
  async getKnownApprovalStageKeys() {
    const res = await query('SELECT approval_request_id, current_stage, approver_user_id FROM email_approval_queue');
    return new Set(
      res.rows.map(
        (row) =>
          `${String(row.approval_request_id ?? '')}:${String(row.current_stage ?? '')}:${String(row.approver_user_id ?? '')}`
      )
    );
  }

  async enqueue({ approvalRequestId, currentStage, approverUserId }) {
    const sql = `
      INSERT INTO email_approval_queue (approval_request_id, current_stage, approver_user_id, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT DO NOTHING;
    `;

    await query(sql, [approvalRequestId, currentStage, approverUserId]);
    return { approvalRequestId, currentStage, approverUserId, status: 'pending' };
  }

  async getPendingItems() {
    const res = await query("SELECT * FROM email_approval_queue WHERE status = 'pending' ORDER BY id ASC");
    return res.rows;
  }

  async markProcessing(id) {
    await query("UPDATE email_approval_queue SET status = 'processing', updated_at = now() WHERE id = $1", [id]);
  }

  async markSent(id) {
    await query("UPDATE email_approval_queue SET status = 'sent', updated_at = now() WHERE id = $1", [id]);
  }

  async markFailed(id, errorMessage) {
    await query(
      `UPDATE email_approval_queue
       SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, errorMessage]
    );
  }
}

export const postgresQueueStore = new PostgresQueueStore();
export default postgresQueueStore;
