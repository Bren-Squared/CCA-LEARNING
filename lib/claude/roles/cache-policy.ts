import { cardWriterRole } from "./card-writer";
import { deduplicatorRole } from "./deduplicator";
import { explainerRole } from "./explainer";
import { generatorRole } from "./generator";
import { graderRole } from "./grader";
import { reviewerRole } from "./reviewer";
import { rubricDrafterRole } from "./rubric-drafter";
import { tutorRole } from "./tutor";

/**
 * Source of truth for which roles run with `cacheSystem: true` and therefore
 * SHOULD show a non-trivial prompt-cache hit rate after the first ~1 call
 * within the cache TTL. Used by `lib/spend/summary.ts` to compute Phase 14's
 * cache-efficiency panel without each call site having to import every role.
 *
 * Unknown roles default to `false` — that means absent-role-name → "no-cache",
 * which is the safe interpretation: we never raise a missing-cache warning on
 * a role whose policy we don't know.
 */
const KNOWN_ROLES = [
  cardWriterRole,
  deduplicatorRole,
  explainerRole,
  generatorRole,
  graderRole,
  reviewerRole,
  rubricDrafterRole,
  tutorRole,
];

const POLICY = new Map<string, boolean>(
  KNOWN_ROLES.map((r) => [r.name, r.cacheSystem]),
);

/**
 * `bulk-gen` submits requests through the Anthropic Batches API tagged with
 * the synthetic role name `generator_batch`. The system prompt is the same
 * cacheable payload the live generator uses, so it inherits the generator's
 * cache policy.
 */
POLICY.set("generator_batch", generatorRole.cacheSystem);

export function roleExpectsCache(roleName: string): boolean {
  return POLICY.get(roleName) ?? false;
}

export function listKnownRoles(): string[] {
  return Array.from(POLICY.keys()).sort();
}
