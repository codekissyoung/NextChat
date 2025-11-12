import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

// ============================================================
// 安全的只读命令白名单
// ============================================================
// 这个映射表定义了无参数工具的实际 shell 命令
// 键（key）: 工具名称（对应 SHELL_TOOLS 中的 function.name）
// 值（value）: 实际执行的 shell 命令参数数组
//
// 🔒 安全原则：
// - 所有命令都是只读操作（查看、列出、显示）
// - 禁止任何写入、删除、修改操作（rm、mv、cp、write 等）
// - 命令参数固定，不接受用户输入（防止命令注入）
//
// ⚠️ 注意：
// - list_files_in_path 支持路径参数，不在此列表中，单独处理
// - 命令执行有 10 秒超时限制
// - 输出限制 1MB（maxBuffer）
// ============================================================
const SAFE_COMMANDS: Record<string, string[]> = {
  list_files: ["ls", "-lh"], // 列出文件（人类可读格式）
  tree_structure: [
    "tree",
    "-L",
    "2",
    "-I",
    "node_modules|.git|.next|dist|build",
  ], // 树状结构（2层，排除构建目录）
  current_directory: ["pwd"], // 当前目录
  current_time: ["date"], // 系统时间
  disk_usage: ["df", "-h"], // 磁盘使用情况
  system_info: ["uname", "-a"], // 系统信息
  node_version: ["node", "--version"], // Node.js 版本
  git_status: ["git", "status", "--short"], // Git 状态（简短格式）
};

// ============================================================
// 路径安全验证（5 层防护）
// ============================================================
// 防止 AI 通过工具参数进行目录穿越攻击或访问敏感文件
//
// 🛡️ 安全策略：
// 1. 标准化输入 - 移除空格
// 2. 禁止相对路径穿越 - 拒绝包含 ".." 的路径
// 3. 禁止访问系统目录 - 拒绝 /etc、/root 等敏感路径
// 4. 解析为绝对路径 - 基于项目根目录（process.cwd()）解析
// 5. 边界检查 - 确保最终路径在项目目录内
//
// ❌ 攻击示例（会被拦截）：
// - "../../../etc/passwd" → 防护层 2 拦截
// - "/etc/shadow" → 防护层 3 拦截
// - "app/../../outside" → 防护层 5 拦截（解析后在项目外）
//
// ✅ 合法示例（会通过）：
// - "app/api" → /Users/link/workspace/NextChat/app/api
// - "." → /Users/link/workspace/NextChat
// - "src/components" → /Users/link/workspace/NextChat/src/components
// ============================================================
function sanitizePath(inputPath: string): string {
  // 防护层 1: 移除前后空格
  inputPath = inputPath.trim();

  // 防护层 2: 防止目录穿越攻击（不允许 ..）
  if (inputPath.includes("..")) {
    throw new Error("Path traversal not allowed (contains '..')");
  }

  // 防护层 3: 不允许绝对路径到敏感目录
  const sensitiveAbsolutePaths = [
    "/etc",
    "/root",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/sys",
    "/proc",
  ];
  for (const sensitivePath of sensitiveAbsolutePaths) {
    if (inputPath.startsWith(sensitivePath)) {
      throw new Error(`Access to ${sensitivePath} is not allowed`);
    }
  }

  // 防护层 4: 如果是相对路径，返回解析后的路径（基于当前工作目录）
  // 这样可以确保路径在项目范围内
  const resolvedPath = path.resolve(process.cwd(), inputPath);

  // 防护层 5: 最终检查：确保解析后的路径在项目目录内
  if (!resolvedPath.startsWith(process.cwd())) {
    throw new Error("Path must be within project directory");
  }

  return resolvedPath;
}

// ============================================================
// 工具执行函数
// ============================================================
// 这个函数被 app/api/moonshot.ts 的 ReACT 循环调用
// 用于执行 Kimi 在 tool_calls 中请求的工具
//
// 📥 输入参数：
// - toolName: Kimi 在 tool_calls[].function.name 中返回的工具名称
// - args: Kimi 在 tool_calls[].function.arguments 中返回的参数（JSON 对象）
//
// 📤 返回值：
// - string: 工具执行结果（stdout/stderr），会以 role: "tool" 的消息返回给 Kimi
//
// 🔄 调用流程示例：
// 用户："app/api 目录下有哪些文件？"
// → Kimi 返回: { tool_calls: [{ function: { name: "list_files_in_path", arguments: '{"path":"app/api"}' } }] }
// → 本函数: executeShellTool("list_files_in_path", { path: "app/api" })
// → 执行: ls -lh（在 /Users/link/workspace/NextChat/app/api 目录）
// → 返回: "total 96K\n-rw-r--r-- 1 link staff 1.2K moonshot.ts\n..."
// → 结果返回给 Kimi，Kimi 基于结果回答用户
// ============================================================
export async function executeShellTool(
  toolName: string,
  args?: any,
): Promise<string> {
  try {
    // ========== 处理带参数的工具 ==========
    if (toolName === "list_files_in_path") {
      const targetPath = args?.path || ".";
      const safePath = sanitizePath(targetPath);

      console.log("═══════════════════════════════════════════════════");
      console.log(`[Shell Tool] 🔧 Tool: list_files_in_path`);
      console.log(`[Shell Tool] 📥 Input: path="${targetPath}"`);
      console.log(`[Shell Tool] 🔒 Sanitized: "${safePath}"`);

      const { stdout, stderr } = await execAsync("ls -lh", {
        cwd: safePath,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });

      const result = stdout || stderr || "(empty directory)";
      console.log(`[Shell Tool] 📤 Output (${result.length} chars):`);
      console.log(result);
      console.log("═══════════════════════════════════════════════════");

      return result;
    }

    // 处理无参数命令
    const commandArgs = SAFE_COMMANDS[toolName];
    if (!commandArgs) {
      return `Error: Tool '${toolName}' not found in whitelist`;
    }

    const [command, ...cmdArgs] = commandArgs;
    const fullCommand = `${command} ${cmdArgs.join(" ")}`;

    console.log("═══════════════════════════════════════════════════");
    console.log(`[Shell Tool] 🔧 Tool: ${toolName}`);
    console.log(`[Shell Tool] 📥 Command: ${fullCommand}`);

    const { stdout, stderr } = await execAsync(fullCommand, {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });

    const result = stdout || stderr;
    console.log(`[Shell Tool] 📤 Output (${result.length} chars):`);
    console.log(result);
    console.log("═══════════════════════════════════════════════════");

    return result;
  } catch (error: any) {
    console.error(`[Shell Tool] Error:`, error);
    return `Error executing ${toolName}: ${error.message}`;
  }
}

// ============================================================
// Kimi Tool Calls（工具调用）定义
// ============================================================
// 这是符合 OpenAI Function Calling / Kimi Tool Calls 规范的工具定义
//
// 📖 工作原理：
// 1. 将工具数组通过 API 请求的 tools 参数发送给 Kimi
// 2. Kimi 根据用户问题和工具描述，决定是否调用工具
// 3. Kimi 返回 tool_calls 数组，包含工具名称和参数（JSON 格式）
// 4. 服务端解析 tool_calls，调用 executeShellTool() 执行真实命令
// 5. 将工具执行结果以 role: "tool" 的消息返回给 Kimi
// 6. Kimi 基于工具结果继续推理，直到得出最终答案
//
// 🔑 JSON Schema 结构：
// - type: "function" - 固定值，表示这是一个函数工具
// - function.name - 工具唯一标识，Kimi 会在 tool_calls 中返回这个名称
// - function.description - 工具功能说明，Kimi 根据这个判断是否使用该工具
// - function.parameters - JSON Schema 格式的参数定义
//   - type: "object" - 参数类型（对象）
//   - properties - 具体参数列表
//     - 参数名: { type, description } - 参数类型和说明
//   - required - 必填参数数组（空数组表示无必填参数）
//
// ⚠️ 重要约束：
// 1. list_files_in_path 可以指定路径，其他工具都是无参数的固定命令
// 2. 路径必须是项目内的相对路径（如 "app/api"），不允许 ".." 目录穿越
// 3. 如果某个工具连续 2 次返回相同结果，说明该方法不适用，应立即尝试其他工具或直接回答用户
// ============================================================
export const SHELL_TOOLS = [
  // ========== 基础工具（无参数） ==========
  {
    type: "function", // 固定值，表示函数工具
    function: {
      name: "current_directory", // 工具名称，Kimi 会在 tool_calls 中返回这个
      description:
        "【优先使用】显示当前工作目录的绝对路径。执行 pwd 命令。建议在使用其他文件工具前先调用此工具了解当前位置。",
      parameters: { type: "object", properties: {}, required: [] }, // 空参数（无需传参）
    },
  },
  {
    type: "function",
    function: {
      name: "tree_structure",
      description:
        "【推荐】显示当前目录的树状结构（最多2层深度）。自动排除 node_modules、.git、.next、dist、build。适合快速了解项目整体结构。执行 tree -L 2 命令。",
      parameters: { type: "object", properties: {}, required: [] }, // 空参数（无需传参）
    },
  },
  // ========== 带参数工具（支持指定路径） ==========
  {
    type: "function",
    function: {
      name: "list_files_in_path",
      description:
        "【查看指定目录】列出指定路径下的文件和文件夹（仅一层，不递归）。可以指定相对路径如 'app/api' 或 'src/components'。执行 ls -lh 命令。✅ 这是唯一支持指定路径的工具。",
      parameters: {
        type: "object", // 参数类型为对象
        properties: {
          // 参数列表
          path: {
            // 参数名
            type: "string", // 参数类型
            description:
              // Kimi 会根据这个描述理解参数用途和约束
              "要查看的目录路径（相对路径，如 'app/api' 或 'src'）。不指定则默认为当前目录 '.'。⚠️ 不允许使用 '..' 进行目录穿越。",
          },
        },
        required: [], // 空数组表示 path 是可选参数，不传则默认为 "."
      },
    },
  },
  // ========== 文件系统工具 ==========
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "列出当前目录的文件和文件夹（仅一层，不递归）。如果需要查看其他目录，请使用 list_files_in_path。执行 ls -lh 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  // ========== 系统信息工具 ==========
  {
    type: "function",
    function: {
      name: "current_time",
      description: "获取服务器当前的系统时间和日期。使用 date 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "disk_usage",
      description: "查看所有挂载点的磁盘空间使用情况。使用 df -h 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description:
        "获取系统基本信息（操作系统类型、内核版本、架构等）。使用 uname -a 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "node_version",
      description:
        "查看服务器安装的 Node.js 版本号。使用 node --version 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  // ========== Git 工具 ==========
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "查看 Git 仓库的当前状态（修改、新增、删除的文件）。使用 git status --short 命令。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
