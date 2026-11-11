import assert from "node:assert/strict";
import test from "node:test";

import { ConversationService } from "../src/application/conversation-service.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";

test("ConversationService returns the canonical workspace root", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const service = new ConversationService(store);

  const conversation = store.createConversation(
    "/workspace/project",
    "workspace_sandbox",
  );

  assert.deepEqual(conversation.workspace, {
    name: "project",
    canonicalPath: "/workspace/project",
  });
  assert.equal(
    (await service.getConversation(conversation.id)).workspace.canonicalPath,
    "/workspace/project",
  );
});
