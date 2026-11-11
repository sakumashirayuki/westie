import { z } from "zod";

import { defineTool, type Tool } from "../tools.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 5;

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number(),
  })),
});

export interface WebSearchToolOptions {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createWebSearchTool(
  options: WebSearchToolOptions,
): Tool {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new Error("Tavily API key is required.");
  }
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information and return up to five relevant results.",
    impact: "Sends the search query to Tavily and reads search result snippets.",
    inputSchema: z.strictObject({
      query: z.string().trim().min(1),
    }),
    summarizeInput({ query }) {
      return { query };
    },
    async execute({ query }, context) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(
          new DOMException("Tavily search timed out.", "TimeoutError"),
        ),
        timeoutMs,
      );
      const signal = context.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([context.signal, timeoutController.signal]);
      try {
        const response = await fetchRequest(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            max_results: MAX_RESULTS,
            include_answer: false,
          }),
          signal,
        });

        if (!response.ok) {
          throw new Error(`Tavily search failed with HTTP ${response.status}.`);
        }

        const parsed = tavilyResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error("Tavily returned an invalid search response.");
        }

        return {
          results: parsed.data.results.slice(0, MAX_RESULTS).map((result) => ({
            title: result.title,
            url: result.url,
            content: result.content,
            score: result.score,
          })),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
