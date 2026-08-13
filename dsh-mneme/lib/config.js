import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  maxInjectedItems: z.natural().min(1).max(20).default(5),
  importanceThreshold: z.natural().min(1).max(5).default(3),
  autoDream: z.boolean().default(true),
  dreamThresholdCount: z.natural().min(1).max(1000).default(10),
  dreamThresholdChars: z.natural().min(100).max(100000).default(5000),
  dreamDelayMs: z.natural().min(0).max(60000).default(2000),
  dreamProvider: z.string(),
  dreamModel: z.string()
});
