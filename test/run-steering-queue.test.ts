import assert from "node:assert/strict";
import test from "node:test";

import { RunSteeringQueue } from "../src/application/run-steering-queue.js";
import {
  MAX_PENDING_STEERING_MESSAGES,
  MAX_STEERING_MESSAGE_BYTES,
} from "../src/protocol.js";

test("enqueue returns ascending seq and take returns messages in order", () => {
  const queue = new RunSteeringQueue();
  assert.equal(queue.enqueue("run-1", "first"), 0);
  assert.equal(queue.enqueue("run-1", "second"), 1);
  assert.deepEqual(queue.take("run-1", 1), [
    { seq: 0, content: "first" },
    { seq: 1, content: "second" },
  ]);
});

test("rejects a message over the byte limit", () => {
  const queue = new RunSteeringQueue();
  assert.throws(
    () => queue.enqueue("run-1", "x".repeat(MAX_STEERING_MESSAGE_BYTES + 1)),
  );
});

test("rejects a message when the queue is full", () => {
  const queue = new RunSteeringQueue();
  for (let index = 0; index < MAX_PENDING_STEERING_MESSAGES; index += 1) {
    queue.enqueue("run-1", `msg ${index}`);
  }
  assert.throws(() => queue.enqueue("run-1", "overflow"));
});

test("take drains the queue so a second take is empty", () => {
  const queue = new RunSteeringQueue();
  queue.enqueue("run-1", "only");
  assert.equal(queue.take("run-1", 1).length, 1);
  assert.deepEqual(queue.take("run-1", 2), []);
});

test("dispose clears the queue so it no longer returns messages", () => {
  const queue = new RunSteeringQueue();
  queue.enqueue("run-1", "pending");
  queue.dispose("run-1");
  assert.deepEqual(queue.take("run-1", 1), []);
});
