import type { ExecutionMode } from "../run-client";

export function AccessModeBadge({ mode }: { mode: ExecutionMode }) {
  const fullAccess = mode === "full_access";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-[0.04em] ${
        fullAccess
          ? "border-[#dfc485] bg-[#fff9eb] text-[#79581a]"
          : "border-[#b9d2c4] bg-[#edf5ef] text-[#276c52]"
      }`}
    >
      {fullAccess ? "Full Access" : "Sandbox"}
    </span>
  );
}
