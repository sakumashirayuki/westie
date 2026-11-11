import assert from "node:assert/strict";
import test from "node:test";

import {
  MacOsHostDirectoryPicker,
  MacOsHostFilePicker,
} from "../src/infrastructure/host-file-picker.js";

test("returns the file selected by osascript", async () => {
  let receivedCommand:
    | {
        readonly executable: string;
        readonly args: readonly string[];
        readonly signal?: AbortSignal;
      }
    | undefined;
  const controller = new AbortController();
  const picker = new MacOsHostFilePicker(async (command) => {
    receivedCommand = command;
    return {
      exitCode: 0,
      stdout: "/Users/example/project input/data.csv\n",
    };
  });

  assert.deepEqual(await picker.pickFile(controller.signal), {
    status: "selected",
    path: "/Users/example/project input/data.csv",
  });
  assert.equal(receivedCommand?.executable, "/usr/bin/osascript");
  assert.equal(receivedCommand?.args[0], "-e");
  assert.match(receivedCommand?.args[1] ?? "", /choose file/);
  assert.equal(receivedCommand?.signal, controller.signal);
});

test("returns cancelled when the user closes the picker", async () => {
  const picker = new MacOsHostFilePicker(async (command) => {
    const script = command.args[1] ?? "";
    const marker = script.match(
      /return "(__MY_AGENT_HARNESS_FILE_PICKER_CANCELLED__)"/,
    )?.[1];
    assert.ok(marker);
    return { exitCode: 0, stdout: `${marker}\n` };
  });

  assert.deepEqual(await picker.pickFile(), { status: "cancelled" });
});

test("does not expose osascript failure details", async () => {
  const picker = new MacOsHostFilePicker(async () => ({
    exitCode: 1,
    stdout: "private failure details",
  }));

  await assert.rejects(
    picker.pickFile(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Could not open the macOS file picker." &&
      !error.message.includes("private failure details"),
  );
});

test("forwards cancellation through AbortSignal", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  const picker = new MacOsHostFilePicker(
    (command) =>
      new Promise((_resolve, reject) => {
        command.signal?.addEventListener(
          "abort",
          () => reject(command.signal?.reason),
          { once: true },
        );
      }),
  );

  const selection = picker.pickFile(controller.signal);
  controller.abort(reason);

  await assert.rejects(selection, (error: unknown) => error === reason);
});

test("does not invoke osascript for an already aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const picker = new MacOsHostFilePicker(async () => {
    invoked = true;
    return { exitCode: 0, stdout: "/tmp/file\n" };
  });

  await assert.rejects(
    picker.pickFile(controller.signal),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(invoked, false);
});

test("returns the directory selected by osascript", async () => {
  let script = "";
  const picker = new MacOsHostDirectoryPicker(async (command) => {
    script = command.args[1] ?? "";
    return {
      exitCode: 0,
      stdout: "/Users/example/my project/\n",
    };
  });

  assert.deepEqual(await picker.pickDirectory(), {
    status: "selected",
    path: "/Users/example/my project/",
  });
  assert.match(script, /choose folder/);
  assert.doesNotMatch(script, /choose file/);
});

test("directory picker preserves cancellation and hides failures", async () => {
  const cancelled = new MacOsHostDirectoryPicker(async (command) => {
    const marker = (command.args[1] ?? "").match(
      /return "(__MY_AGENT_HARNESS_FILE_PICKER_CANCELLED__)"/,
    )?.[1];
    assert.ok(marker);
    return { exitCode: 0, stdout: marker };
  });
  assert.deepEqual(await cancelled.pickDirectory(), {
    status: "cancelled",
  });

  const failed = new MacOsHostDirectoryPicker(async () => ({
    exitCode: 1,
    stdout: "private directory picker failure",
  }));
  await assert.rejects(
    failed.pickDirectory(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Could not open the macOS directory picker." &&
      !error.message.includes("private directory picker failure"),
  );
});
