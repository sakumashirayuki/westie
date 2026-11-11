import { SUMMARY_HEADINGS } from "../../src/application/context-compactor.js";

/** 带齐规定标题的合格摘要；body 放在第一节，其余各节写「无」。 */
export function validSummary(body: string): string {
  return SUMMARY_HEADINGS
    .map((heading, index) => `## ${heading}\n${index === 0 ? body : "无"}`)
    .join("\n\n");
}
