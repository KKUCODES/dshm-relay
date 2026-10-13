import { z } from 'zod'
import { tokenSchema } from '@dsh-mobile/protocol'

// 未配置时保持个人模式；错误拼写不能意外开放注册。
export const registrationConfigSchema = z.object({
  registrationMode: z.enum(['open', 'private']).default('private'),
  enrollmentToken: z.string().optional(),
}).superRefine((config, ctx) => {
  if (config.registrationMode === 'private' && !tokenSchema.safeParse(config.enrollmentToken).success) {
    ctx.addIssue({ code: 'custom', path: ['enrollmentToken'], message: 'Personal mode requires a valid ENROLLMENT_TOKEN' })
  }
})
