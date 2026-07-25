import { z } from 'zod'

export const registerSchema = z.object({
  email: z.string().email('невірна пошта'),
  password: z.string().min(8, 'мінімум 8 символів').max(200),
  displayName: z.string().trim().min(2, 'мінімум 2 символи').max(80),
  capability: z.enum(['invest', 'borrow']),
})

export const loginSchema = z.object({
  email: z.string().email('невірна пошта'),
  password: z.string().min(1, 'введіть пароль'),
})

export const searchSchema = z.object({
  q: z.string().trim().min(2, 'мінімум 2 символи'),
})
