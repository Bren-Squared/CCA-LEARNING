import Anthropic from "@anthropic-ai/sdk";
import type { ParsedQuestion } from "./types";

export interface BloomClassification {
  questionId: string;
  bloomLevel: 1 | 2 | 3 | 4 | 5 | 6;
  justification: string;
}

export interface ClassifyOptions {
  apiKey: string | undefined;
  model?: string;
}

// Fallback when no API key is available. Most exam-representative MCQs are Apply
// or Analyze per spec (empirical Apply–Evaluate band); 3 is the safe mid-point
// the reviewer in Phase 6 will refine.
const FALLBACK_LEVEL: BloomClassification["bloomLevel"] = 3;
const FALLBACK_JUSTIFICATION =
  "unclassified: heuristic default pending Claude pass (see Phase 2 ingest re-run)";

export async function classifySeedQuestionsBloom(
  questions: ParsedQuestion[],
  opts: ClassifyOptions,
): Promise<BloomClassification[]> {
  if (!opts.apiKey) {
    return questions.map((q) => ({
      questionId: q.id,
      bloomLevel: FALLBACK_LEVEL,
      justification: FALLBACK_JUSTIFICATION,
    }));
  }

  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? "claude-sonnet-4-6";

  const tool: Anthropic.Tool = {
    name: "emit_bloom_classifications",
    description:
      "Record the Bloom's Taxonomy level (1-6) for each seed question in order. Use 1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create. Include a one-sentence justification that names the cognitive operation the stem requires.",
    input_schema: {
      type: "object",
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question_id: { type: "string" },
              bloom_level: { type: "integer", minimum: 1, maximum: 6 },
              justification: { type: "string", minLength: 10 },
            },
            required: ["question_id", "bloom_level", "justification"],
            additionalProperties: false,
          },
        },
      },
      required: ["classifications"],
      additionalProperties: false,
    },
  };

  const compactQuestions = questions.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options,
  }));

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [tool],
    tool_choice: { type: "tool", name: "emit_bloom_classifications" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Classify each of the following seed MCQs by the Bloom's Taxonomy level the question actually demands of the test-taker. " +
              "Focus on the cognitive operation the stem requires, not the topic area.\n\n" +
              JSON.stringify(compactQuestions, null, 2),
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Bloom classifier returned no tool_use block");
  }
  const input = toolUse.input as {
    classifications: Array<{
      question_id: string;
      bloom_level: number;
      justification: string;
    }>;
  };

  return input.classifications.map((c) => ({
    questionId: c.question_id,
    bloomLevel: c.bloom_level as BloomClassification["bloomLevel"],
    justification: c.justification,
  }));
}
