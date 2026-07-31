export class UnknownApproverError extends Error {
  constructor(userCode) {
    super(`No stored SAP credentials for user code '${userCode}'.`);
    this.name = 'UnknownApproverError';
    this.code = 'UNKNOWN_APPROVER';
    this.userCode = userCode;
  }
}
