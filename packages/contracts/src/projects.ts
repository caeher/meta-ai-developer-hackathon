import { z } from "zod";

export const ProjectNameInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const ProjectPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export const ProjectMessageInputSchema = z.object({
  requestId: z.string().trim().min(8).max(128),
  content: z.string().min(1).max(100_000),
});

export const ProjectMessagePageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ProjectMessageSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(100_000),
  requestId: z.string().min(8).max(128),
  sequence: z.number().int().positive(),
  createdAt: z.date(),
});
