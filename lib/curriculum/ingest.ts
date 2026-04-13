import { sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../db";
import { schema } from "../db";
import type { BloomClassification } from "./bloom-classify";
import type { ParsedCurriculum } from "./types";

export function persistCurriculum(
  db: Db,
  curriculum: ParsedCurriculum,
  bloom: BloomClassification[],
): void {
  const bloomByQid = new Map(
    bloom.map((b) => [b.questionId, b] as const),
  );

  db.transaction((tx) => {
    for (const d of curriculum.domains) {
      tx.insert(schema.domains)
        .values({
          id: d.id,
          title: d.title,
          weightBps: d.weightBps,
          orderIndex: d.orderIndex,
        })
        .onConflictDoUpdate({
          target: schema.domains.id,
          set: {
            title: d.title,
            weightBps: d.weightBps,
            orderIndex: d.orderIndex,
          },
        })
        .run();
    }

    for (const t of curriculum.taskStatements) {
      tx.insert(schema.taskStatements)
        .values({
          id: t.id,
          domainId: t.domainId,
          title: t.title,
          knowledgeBullets: t.knowledgeBullets,
          skillsBullets: t.skillsBullets,
          orderIndex: t.orderIndex,
        })
        .onConflictDoUpdate({
          target: schema.taskStatements.id,
          set: {
            domainId: t.domainId,
            title: t.title,
            knowledgeBullets: t.knowledgeBullets,
            skillsBullets: t.skillsBullets,
            orderIndex: t.orderIndex,
          },
        })
        .run();
    }

    for (const s of curriculum.scenarios) {
      tx.insert(schema.scenarios)
        .values({
          id: s.id,
          title: s.title,
          description: s.description,
          orderIndex: s.orderIndex,
        })
        .onConflictDoUpdate({
          target: schema.scenarios.id,
          set: {
            title: s.title,
            description: s.description,
            orderIndex: s.orderIndex,
          },
        })
        .run();

      tx.delete(schema.scenarioDomainMap)
        .where(sql`${schema.scenarioDomainMap.scenarioId} = ${s.id}`)
        .run();

      for (const dId of s.primaryDomainIds) {
        tx.insert(schema.scenarioDomainMap)
          .values({ scenarioId: s.id, domainId: dId, isPrimary: true })
          .run();
      }
    }

    for (const q of curriculum.questions) {
      const bc = bloomByQid.get(q.id);
      tx.insert(schema.questions)
        .values({
          id: q.id,
          stem: q.stem,
          options: q.options,
          correctIndex: q.correctIndex,
          explanations: q.explanations,
          taskStatementId: q.taskStatementId,
          scenarioId: q.scenarioId ?? null,
          difficulty: q.difficulty,
          bloomLevel: bc?.bloomLevel ?? 3,
          bloomJustification:
            bc?.justification ?? "unclassified: awaiting Claude pass",
          source: "seed",
          status: "active",
        })
        .onConflictDoUpdate({
          target: schema.questions.id,
          set: {
            stem: q.stem,
            options: q.options,
            correctIndex: q.correctIndex,
            explanations: q.explanations,
            taskStatementId: q.taskStatementId,
            scenarioId: q.scenarioId ?? null,
            difficulty: q.difficulty,
            bloomLevel: bc?.bloomLevel ?? 3,
            bloomJustification:
              bc?.justification ?? "unclassified: awaiting Claude pass",
            updatedAt: new Date(),
          },
        })
        .run();
    }

    for (const e of curriculum.exercises) {
      tx.insert(schema.preparationExercises)
        .values({
          id: e.id,
          title: e.title,
          description: e.description,
          domainsReinforced: e.domainsReinforced,
          orderIndex: e.orderIndex,
        })
        .onConflictDoUpdate({
          target: schema.preparationExercises.id,
          set: {
            title: e.title,
            description: e.description,
            domainsReinforced: e.domainsReinforced,
            orderIndex: e.orderIndex,
          },
        })
        .run();

      for (const step of e.steps) {
        const stepId = `${e.id}-S${step.stepIdx}`;
        tx.insert(schema.preparationSteps)
          .values({
            id: stepId,
            exerciseId: e.id,
            stepIdx: step.stepIdx,
            prompt: step.prompt,
          })
          .onConflictDoUpdate({
            target: schema.preparationSteps.id,
            set: {
              exerciseId: e.id,
              stepIdx: step.stepIdx,
              prompt: step.prompt,
            },
          })
          .run();
      }
    }
  });
}

export function writeIngestHash(
  db: Db,
  pdfHash: string,
  ingestedAt: Date,
): void {
  db.insert(schema.settings)
    .values({
      id: 1,
      ingestPdfHash: pdfHash,
      ingestedAt,
    })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: { ingestPdfHash: pdfHash, ingestedAt },
    })
    .run();
}

export function readIngestHash(db: Db): string | null {
  const rows = db.select().from(schema.settings).all();
  return rows[0]?.ingestPdfHash ?? null;
}

export interface IngestCounts {
  domains: number;
  taskStatements: number;
  scenarios: number;
  questions: number;
  exercises: number;
}

export function countIngested(db: Db): IngestCounts {
  const count = (t: SQLiteTable) =>
    (db.select({ n: sql<number>`count(*)` }).from(t).get()?.n ?? 0) as number;
  return {
    domains: count(schema.domains),
    taskStatements: count(schema.taskStatements),
    scenarios: count(schema.scenarios),
    questions: count(schema.questions),
    exercises: count(schema.preparationExercises),
  };
}
