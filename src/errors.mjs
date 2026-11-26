export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

export class UpstreamError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}
