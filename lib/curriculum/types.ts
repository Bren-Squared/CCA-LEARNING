import { z } from "zod";

export const ParsedDomain = z.object({
  id: z.string().regex(/^D[1-5]$/),
  title: z.string().min(1),
  weightBps: z.number().int().min(0).max(10000),
  orderIndex: z.number().int().nonnegative(),
});

export const ParsedTaskStatement = z.object({
  id: z.string().regex(/^D[1-5]\.[1-9][0-9]?$/),
  domainId: z.string().regex(/^D[1-5]$/),
  title: z.string().min(1),
  knowledgeBullets: z.array(z.string().min(1)).min(1),
  skillsBullets: z.array(z.string().min(1)).min(1),
  orderIndex: z.number().int().nonnegative(),
});

export const ParsedScenario = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  primaryDomainIds: z.array(z.string().regex(/^D[1-5]$/)).min(1),
  orderIndex: z.number().int().nonnegative(),
});

export const ParsedQuestion = z.object({
  id: z.string().min(1),
  stem: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanations: z.array(z.string()).length(4),
  taskStatementId: z.string().regex(/^D[1-5]\.[1-9][0-9]?$/),
  scenarioId: z.string().nullable(),
  difficulty: z.number().int().min(1).max(5).default(3),
});

export const ParsedExercise = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  domainsReinforced: z.array(z.string().regex(/^D[1-5](\.\d+)?$/)).min(1),
  orderIndex: z.number().int().nonnegative(),
  steps: z
    .array(
      z.object({
        stepIdx: z.number().int().nonnegative(),
        prompt: z.string().min(1),
      }),
    )
    .min(1),
});

export const ParsedCurriculum = z.object({
  domains: z.array(ParsedDomain),
  taskStatements: z.array(ParsedTaskStatement),
  scenarios: z.array(ParsedScenario),
  questions: z.array(ParsedQuestion),
  exercises: z.array(ParsedExercise),
});

export type ParsedDomain = z.infer<typeof ParsedDomain>;
export type ParsedTaskStatement = z.infer<typeof ParsedTaskStatement>;
export type ParsedScenario = z.infer<typeof ParsedScenario>;
export type ParsedQuestion = z.infer<typeof ParsedQuestion>;
export type ParsedExercise = z.infer<typeof ParsedExercise>;
export type ParsedCurriculum = z.infer<typeof ParsedCurriculum>;
