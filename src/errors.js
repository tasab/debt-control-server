/**
 * Every failure the client is expected to handle is an AppError with a stable
 * `code` from SERVER_PLAN §2.4. Anything else that escapes becomes a 500 with
 * code INTERNAL — codes are part of the API contract, so they never get
 * invented ad-hoc at a call site.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.fields = fields
  }
}

export const errors = {
  unauthorized: () => new AppError('UNAUTHORIZED', 'Потрібна автентифікація', { status: 401 }),
  forbidden: (message = 'Немає доступу') => new AppError('FORBIDDEN', message, { status: 403 }),
  forbiddenCapability: (capability) =>
    new AppError('FORBIDDEN_CAPABILITY', `Потрібна можливість «${capability}»`, { status: 403 }),
  notFound: (what = 'Ресурс') => new AppError('NOT_FOUND', `${what} не знайдено`, { status: 404 }),
  validation: (message, fields) => new AppError('VALIDATION', message, { status: 422, fields }),
  conflict: (code, message, fields) => new AppError(code, message, { status: 409, fields }),

  insufficientFunds: (fields) =>
    new AppError('INSUFFICIENT_FUNDS', 'Недостатньо коштів', { status: 409, fields }),
  quoteExpired: () =>
    new AppError('QUOTE_EXPIRED', 'Курс протух, оновіть котирування', { status: 409 }),
  rateStale: () =>
    new AppError('RATE_STALE', 'Курс недоступний, спробуйте пізніше', { status: 503 }),
  requestNotOpen: () =>
    new AppError('REQUEST_NOT_OPEN', 'Заявка більше не приймає фінансування', { status: 409 }),
  belowMinTicket: (fields) =>
    new AppError('BELOW_MIN_TICKET', 'Сума менша за мінімальний внесок', { status: 409, fields }),
  overfunded: (fields) =>
    new AppError('OVERFUNDED', 'Сума перевищує залишок заявки', { status: 409, fields }),
  idempotencyConflict: () =>
    new AppError(
      'IDEMPOTENCY_CONFLICT',
      'Той самий Idempotency-Key вже використано з іншими даними',
      { status: 409 },
    ),
}
