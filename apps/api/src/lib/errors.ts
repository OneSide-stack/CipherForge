export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, detail?: string) => new ApiError(400, 'bad_request', message, detail);
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string, detail?: string) => new ApiError(409, 'conflict', message, detail);
export const tooMany = (message: string) => new ApiError(429, 'rate_limited', message);
export const unavailable = (message: string) => new ApiError(503, 'unavailable', message);
