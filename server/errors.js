export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => {
  throw new HttpError(status, code, message);
};
export const conflict = () =>
  fail(
    409,
    "REVISION_CONFLICT",
    "다른 사람이 변경했어요. 최신 내용을 확인하고 다시 시도해주세요.",
  );
