import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// 安全的只读命令白名单
const SAFE_COMMANDS: Record<string, string[]> = {
  list_files: ["ls", "-lh"],
  current_directory: ["pwd"],
  current_time: ["date"],
  disk_usage: ["df", "-h"],
  system_info: ["uname", "-a"],
  node_version: ["node", "--version"],
  git_status: ["git", "status", "--short"],
  // 添加更多工具...
};

export async function executeShellTool(toolName: string): Promise<string> {
  const commandArgs = SAFE_COMMANDS[toolName];

  if (!commandArgs) {
    return `Error: Tool '${toolName}' not found in whitelist`;
  }

  try {
    const [command, ...args] = commandArgs;
    const { stdout, stderr } = await execAsync(`${command} ${args.join(" ")}`, {
      timeout: 10000, // 10秒超时
      maxBuffer: 1024 * 1024, // 1MB
    });

    console.log(`[Shell Tool] Executed: ${toolName}`);
    return stdout || stderr;
  } catch (error: any) {
    console.error(`[Shell Tool] Error:`, error);
    return `Error executing ${toolName}: ${error.message}`;
  }
}

// 工具定义（返回给AI）
export const SHELL_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前目录的文件和文件夹",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "current_directory",
      description: "显示当前工作目录的路径",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "current_time",
      description: "获取系统当前时间和日期",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "disk_usage",
      description: "查看磁盘空间使用情况",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "获取系统信息（操作系统、内核版本等）",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "node_version",
      description: "查看Node.js版本",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "查看Git仓库状态",
      parameters: { type: "object", properties: {} },
    },
  },
];
