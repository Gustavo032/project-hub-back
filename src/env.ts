// src/env.ts
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.string().default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:8080"),

  JWT_SECRET: z.string().min(20),
  JWT_EXPIRES_IN: z
    .string()
    .default("7d")
    .transform((s) => s.trim()),

  DATABASE_URL: z.string().min(1),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
});

export const env = EnvSchema.parse(process.env);
