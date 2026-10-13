import { z } from 'zod'

// 固定基线 llm-pi-ai Config/PiAiCompatProfile；实际协议适用性继续由 Host 原解析器判断。
export const modelCompatBooleans = ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
  'supportsUsageInStreaming', 'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
  'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'supportsThinkingTokenBudget',
  'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention', 'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools'] as const
export const modelCompatEnums = {
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  thinkingFormat: ['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
  thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
  cacheControlFormat: ['anthropic'],
} as const
export const modelCompatTemplates = ['chatTemplateKwargs', 'chatTemplateArgs'] as const
export const modelCompatKeys = [...modelCompatBooleans, ...Object.keys(modelCompatEnums), 'vllmPriority', ...modelCompatTemplates]
const templateValue = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null(),
  z.object({ $var: z.enum(['thinking.enabled', 'thinking.effort', 'thinking.budget']), omitWhenOff: z.boolean().optional() }).strict()])
// record 解析会忽略 __proto__，必须在解析前检查原始键，不能让它被静默丢弃。
const template = z.unknown().refine(value => !value || typeof value !== 'object'
  || !Object.keys(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))
  .pipe(z.record(z.string().min(1).max(256), templateValue).refine(value => Object.keys(value).length <= 100))
const booleans = Object.fromEntries(modelCompatBooleans.map(key => [key, z.boolean().optional()])) as Record<typeof modelCompatBooleans[number], z.ZodOptional<z.ZodBoolean>>
const fields = { ...booleans,
  maxTokensField: z.enum(modelCompatEnums.maxTokensField).optional(),
  thinkingFormat: z.enum(modelCompatEnums.thinkingFormat).optional(),
  thinkingTokenBudgetField: z.enum(modelCompatEnums.thinkingTokenBudgetField).optional(),
  cacheControlFormat: z.enum(modelCompatEnums.cacheControlFormat).optional(),
  vllmPriority: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  chatTemplateKwargs: template.optional(), chatTemplateArgs: template.optional(),
}
export const modelCompatSchema = z.object(fields).strict()
// 原配置可有空值诊断，读取保留空值便于用户移除；保存时不把它解释为继承。
export const modelCompatViewSchema = z.object(Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.nullable()]))).strict()
