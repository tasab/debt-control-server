/**
 * Every failure the client is expected to handle is an AppError with a stable
 * `code` from SERVER_PLAN §2.4. Anything else that escapes becomes a 500 with
 * code INTERNAL — codes are part of the API contract, so they never get
 * invented ad-hoc at a call site.
 */
export type ErrorFields = Record<string, string> | null

export class AppError extends Error {
  code: string
  status: number
  fields: ErrorFields

  constructor(
    code: string,
    message: string,
    { status = 400, fields = null }: { status?: number; fields?: ErrorFields } = {},
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.fields = fields
  }
}

export const errors = {
  unauthorized: () => new AppError('UNAUTHORIZED', 'Потрібна автентифікація', { status: 401 }),
  forbidden: (message = 'Немає доступу'): AppError => new AppError('FORBIDDEN', message, { status: 403 }),
  forbiddenCapability: (capability: string): AppError =>
    new AppError('FORBIDDEN_CAPABILITY', `Потрібна можливість «${capability}»`, { status: 403 }),
  notFound: (what = 'Ресурс'): AppError => new AppError('NOT_FOUND', `${what} не знайдено`, { status: 404 }),
  validation: (message: string, fields?: ErrorFields): AppError => new AppError('VALIDATION', message, { status: 422, fields }),
  conflict: (code: string, message: string, fields?: ErrorFields): AppError => new AppError(code, message, { status: 409, fields }),

  insufficientFunds: (fields?: ErrorFields): AppError =>
    new AppError('INSUFFICIENT_FUNDS', 'Недостатньо коштів', { status: 409, fields }),
  quoteExpired: () =>
    new AppError('QUOTE_EXPIRED', 'Курс протух, оновіть котирування', { status: 409 }),
  rateStale: () =>
    new AppError('RATE_STALE', 'Курс недоступний, спробуйте пізніше', { status: 503 }),
  requestNotOpen: () =>
    new AppError('REQUEST_NOT_OPEN', 'Заявка більше не приймає фінансування', { status: 409 }),
  belowMinTicket: (fields?: ErrorFields): AppError =>
    new AppError('BELOW_MIN_TICKET', 'Сума менша за мінімальний внесок', { status: 409, fields }),
  overfunded: (fields?: ErrorFields): AppError =>
    new AppError('OVERFUNDED', 'Сума перевищує залишок заявки', { status: 409, fields }),
  idempotencyConflict: () =>
    new AppError(
      'IDEMPOTENCY_CONFLICT',
      'Той самий Idempotency-Key вже використано з іншими даними',
      { status: 409 },
    ),
}
