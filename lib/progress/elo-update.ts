import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db";
import { schema } from "../db";
import {
  DEFAULT_RATING,
  DEFAULT_RD,
  recoverRd,
  updateGlicko,
} from "./elo";
import type { BloomLevel } from "./mastery";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Phase 17 / E4 — One-round Glicko update of both the question's rating and
 * the user's per-(TS, Bloom) skill rating in response to a single MCQ
 * attempt. Wrapped in the surrounding `writeProgressEvent` transaction so a
 * failure rolls back together with the event log + snapshot refresh.
 *
 * Returns `{applied: false}` when the question doesn't exist (synthetic test
 * data, retired-and-deleted rows, etc.) so the surrounding transaction stays
 * intact.
 */
export function applyEloUpdate(
  questionId: string,
  taskStatementId: string,
  bloomLevel: BloomLevel,
  success: boolean,
  opts: { now: number },
  db: DbClient,
): {
  userRating: number;
  questionRating: number;
  applied: boolean;
} {
  const question = db
    .select({
      id: schema.questions.id,
      eloRating: schema.questions.eloRating,
      eloVolatility: schema.questions.eloVolatility,
      attemptsCount: schema.questions.attemptsCount,
      updatedAt: schema.questions.updatedAt,
    })
    .from(schema.questions)
    .where(eq(schema.questions.id, questionId))
    .get();
  if (!question) {
    return { userRating: DEFAULT_RATING, questionRating: DEFAULT_RATING, applied: false };
  }

  const skill = db
    .select()
    .from(schema.userSkill)
    .where(
      and(
        eq(schema.userSkill.taskStatementId, taskStatementId),
        eq(schema.userSkill.bloomLevel, bloomLevel),
      ),
    )
    .get();

  // RD recovery from inactivity. Use the last-update timestamp on each side.
  const userDaysIdle = skill
    ? Math.max(0, (opts.now - skill.updatedAt.getTime()) / DAY_MS)
    : 0;
  const questionDaysIdle = Math.max(
    0,
    (opts.now - question.updatedAt.getTime()) / DAY_MS,
  );

  const userPrior = {
    rating: skill?.eloRating ?? DEFAULT_RATING,
    rd: recoverRd(skill?.eloVolatility ?? DEFAULT_RD, userDaysIdle),
  };
  const questionPrior = {
    rating: question.eloRating,
    rd: recoverRd(question.eloVolatility, questionDaysIdle),
  };

  // From the user's perspective: success → score 1; failure → score 0.
  // From the question's perspective: success means the *question lost*, so
  // its score is 1 - userScore.
  const userScore = success ? 1 : 0;
  const userPosterior = updateGlicko(userPrior, questionPrior, userScore);
  const questionPosterior = updateGlicko(
    questionPrior,
    userPrior,
    1 - userScore,
  );

  const updatedAt = new Date(opts.now);

  db.insert(schema.userSkill)
    .values({
      taskStatementId,
      bloomLevel,
      eloRating: userPosterior.rating,
      eloVolatility: userPosterior.rd,
      attemptsCount: (skill?.attemptsCount ?? 0) + 1,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.userSkill.taskStatementId, schema.userSkill.bloomLevel],
      set: {
        eloRating: userPosterior.rating,
        eloVolatility: userPosterior.rd,
        attemptsCount: (skill?.attemptsCount ?? 0) + 1,
        updatedAt,
      },
    })
    .run();

  db.update(schema.questions)
    .set({
      eloRating: questionPosterior.rating,
      eloVolatility: questionPosterior.rd,
      attemptsCount: question.attemptsCount + 1,
      updatedAt,
    })
    .where(eq(schema.questions.id, questionId))
    .run();

  return {
    userRating: userPosterior.rating,
    questionRating: questionPosterior.rating,
    applied: true,
  };
}
