import { z } from "zod";

import { defineTool } from "../tools.js";

export const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  description: "Get the current date and time in an IANA time zone.",
  impact: "Reads the current system time without changing state.",
  inputSchema: z.strictObject({
    timezone: z.string().min(1),
  }),
  execute({ timezone }) {
    const time = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: timezone,
    }).format(new Date());

    return { time };
  },
});
