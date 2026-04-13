#!/usr/bin/env tsx
import "../lib/polyfills";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

const PDF_PATH = resolve(process.cwd(), "data/exam-guide.pdf");
const OUT_PATH = resolve(process.cwd(), "data/exam-guide.txt");

async function main() {
  const bytes = await readFile(PDF_PATH);
  const doc = await getDocumentProxy(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
  const { text } = await extractText(doc, { mergePages: true });
  const full = Array.isArray(text) ? text.join("\n") : text;
  await writeFile(OUT_PATH, full, "utf8");
  console.log(`wrote ${full.length} chars to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
