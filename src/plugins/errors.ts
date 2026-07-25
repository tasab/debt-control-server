import fp from 'fastify-plugin'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../errors.ts'
import { AmountError } from '../money/amount.ts'

/**
 * One error shape for the whole API (SERVER_PLAN §2.4):
 *   { error: { code, message, fields } }
 * Unknown errors are logged in full and returned as INTERNAL — stack traces
 * never reach the client.
 */
export default fp(async function errorsPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, fields: err.fields } })
    }

    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) fields[issue.path.join('.') || '_'] = issue.message
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'Перевірте введені дані', fields },
      })
    }

    if (err instanceof AmountError) {
      return reply.code(422).send({
        error: {
          code: 'VALIDATION',
          message: err.message,
          fields: err.field ? { [err.field]: err.message } : null,
        },
      })
    }

    if (err.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Забагато запитів, спробуйте пізніше' },
      })
    }

    if (err.validation || err.statusCode === 400) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: err.message, fields: null } })
    }

    request.log.error({ err }, 'unhandled error')
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Внутрішня помилка', fields: null } })
  })
})
