import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  maxInjectedItems: z.number().integer().min(1).max(20).default(5),
  importanceThreshold: z.number().integer().min(1).max(5).default(3)
});
