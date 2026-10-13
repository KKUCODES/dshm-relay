import { z } from 'zod'

// 只传首次配置所需的判定，不暴露配置、凭据引用或提供方错误。
export const modelReadinessSchema = z.object({ kind: z.enum([
  'provider-ready', 'adapter-absent', 'credential-missing', 'unavailable',
]) }).strict()
