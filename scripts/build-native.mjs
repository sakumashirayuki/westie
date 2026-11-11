import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform === "darwin") {
  const outputDirectory = path.resolve("dist/native");
  const outputPath = path.join(
    outputDirectory,
    "process-containment-helper",
  );
  mkdirSync(outputDirectory, { recursive: true });

  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "native/process-containment-helper.c",
      "-lsandbox",
      "-o",
      outputPath,
    ],
    { stdio: "inherit" },
  );

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to build process containment helper (exit ${result.status}).`,
    );
  }
}
