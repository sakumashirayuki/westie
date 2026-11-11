import { HttpRunError } from "./run-client";

export function workspaceGrantErrorMessage(error: unknown): string {
  if (error instanceof HttpRunError) {
    if (error.code === "HOST_FILE_PICKER_CANCELLED") {
      return "未选择文件，授权尚未完成。";
    }
    if (error.code === "WORKSPACE_GRANT_SELECTION_MISMATCH") {
      return "所选文件与 Agent 请求的文件不一致，授权尚未完成。";
    }
    return error.message;
  }
  return "打开系统文件选择器失败，请重试。";
}

export function workspaceSelectionErrorMessage(error: unknown): string {
  if (error instanceof HttpRunError) {
    if (error.code === "HOST_DIRECTORY_PICKER_CANCELLED") {
      return "未选择项目，当前项目没有变化。";
    }
    if (error.code === "WORKSPACE_SELECTION_INVALID") {
      return "所选目录不可用，请重新选择项目。";
    }
    if (
      error.code === "HOST_DIRECTORY_PICKER_UNAVAILABLE" ||
      error.code === "HOST_DIRECTORY_PICKER_FAILED"
    ) {
      return "无法打开 macOS 系统目录选择器，请重试。";
    }
    if (error.code === "WORKSPACE_RUNTIME_UNAVAILABLE") {
      return "项目运行环境初始化失败，请重试或选择其他目录。";
    }
    if (error.code === "FULL_ACCESS_REQUIRES_LOOPBACK") {
      return "Full Access 只能在绑定本机回环地址的服务中使用。";
    }
    if (error.code === "UNTRUSTED_ORIGIN") {
      return "当前页面来源不能打开项目或使用 Full Access。";
    }
    return error.message;
  }
  return "打开项目失败，请重试。";
}

export function conversationDeletionErrorMessage(error: unknown): string {
  if (error instanceof HttpRunError) {
    if (error.code === "CONVERSATION_BUSY") {
      return "会话正在运行，请等待运行结束后再删除。";
    }
    if (error.code === "UNTRUSTED_ORIGIN") {
      return "当前页面来源不能删除会话。";
    }
  }
  return "删除会话失败，请重试。";
}

export function conversationArchiveErrorMessage(error: unknown): string {
  if (error instanceof HttpRunError) {
    if (error.code === "CONVERSATION_BUSY") {
      return "会话正在运行，请等待运行结束后再归档。";
    }
    if (error.code === "CONVERSATION_ARCHIVED") {
      return "该会话已归档。";
    }
    if (error.code === "CONVERSATION_WORKSPACE_SHARED") {
      return "该会话的 worktree 正被其他活动会话使用，无法归档。";
    }
    if (error.code === "UNTRUSTED_ORIGIN") {
      return "当前页面来源不能归档会话。";
    }
  }
  return "归档会话失败，请重试。";
}

export function conversationRenameErrorMessage(error: unknown): string {
  if (error instanceof HttpRunError) {
    if (error.code === "CONVERSATION_BUSY") {
      return "会话正在运行，请等待运行结束后再改名。";
    }
    if (error.code === "UNTRUSTED_ORIGIN") {
      return "当前页面来源不能改名会话。";
    }
    if (error.code === "INVALID_REQUEST") {
      return "标题不合法，请控制在 120 个字符以内。";
    }
  }
  return "重命名会话失败，请重试。";
}
