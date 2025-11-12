import { getServerSideConfig } from "@/app/config/server";
import {
  MOONSHOT_BASE_URL,
  ApiPath,
  ModelProvider,
  ServiceProvider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { isModelNotavailableInServer } from "@/app/utils/model";
import { executeShellTool, SHELL_TOOLS } from "@/app/tools/shell";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[Moonshot Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.Moonshot);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await request(req);
    return response;
  } catch (e) {
    console.error("[Moonshot] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

async function request(req: NextRequest) {
  const controller = new AbortController();

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Moonshot, "");
  let baseUrl = serverConfig.moonshotUrl || MOONSHOT_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Moonshot] path:", path);
  console.log("[Moonshot] baseUrl:", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  // 读取请求体
  let requestBody: any;
  try {
    const clonedBody = await req.text();
    requestBody = JSON.parse(clonedBody);
  } catch (e) {
    console.error("[Moonshot] Failed to parse request body", e);
    clearTimeout(timeoutId);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  // 检查模型权限
  if (serverConfig.customModels) {
    if (
      isModelNotavailableInServer(
        serverConfig.customModels,
        requestBody?.model as string,
        ServiceProvider.Moonshot as string,
      )
    ) {
      clearTimeout(timeoutId);
      return NextResponse.json(
        {
          error: true,
          message: `you are not allowed to use ${requestBody?.model} model`,
        },
        {
          status: 403,
        },
      );
    }
  }

  try {
    const fetchUrl = `${baseUrl}${path}`;
    const authValue = req.headers.get("Authorization") ?? "";

    // ============ ReACT 模式处理 ============
    // ReACT = Reasoning + Acting（推理 + 行动）
    // 工作流程：用户提问 → AI推理 → 调用工具 → 获取结果 → AI再推理 → 循环直到得出答案
    if (path.includes("/chat/completions")) {
      console.log("[Moonshot ReACT] Starting ReACT mode");

      const MAX_ITERATIONS = 10; // 最大工具调用轮数，防止无限循环
      let messages = [...requestBody.messages]; // 复制消息历史，避免修改原始请求
      let iterations = 0;

      // 注入系统提示：强制 AI 使用工具而不是猜测
      // 这条消息会插入到用户消息之前，引导 AI 的行为
      const systemPrompt = {
        role: "system",
        content: `你是一个 ReACT Agent，拥有多个工具来获取实时信息。

🔴 重要规则：
1. 遇到需要实时信息的问题（如当前目录、当前时间、文件列表等），你**必须使用工具**，**不要猜测或编造**。
2. 如果用户问"当前在什么目录"，必须调用 current_directory 工具，不要假设或猜测路径。
3. 如果用户问"有哪些文件"，必须调用 list_files 或 list_files_in_path 工具。
4. 如果用户问"现在几点"，必须调用 current_time 工具。
5. 你的工作环境是真实的 Next.js 项目，不是沙盒，路径是真实的本地文件系统路径。

✅ 正确示例：
用户："当前在什么目录？"
你：调用 current_directory 工具 → 获取真实路径 → 回答用户

❌ 错误示例：
用户："当前在什么目录？"
你：我运行在云端沙盒，路径是 /tmp/sandbox/...（这是猜测，绝对禁止！）`,
      };

      // 将系统提示插入到消息列表开头
      messages.unshift(systemPrompt);

      // ============ 工具调用循环阶段（必须非流式） ============
      while (iterations < MAX_ITERATIONS) {
        iterations++;
        console.log(`\n${"=".repeat(60)}`);
        console.log(
          `[Moonshot ReACT] 🔄 Iteration ${iterations}/${MAX_ITERATIONS}`,
        );
        console.log(`${"=".repeat(60)}`);

        // 📤 日志：发送给 AI 的消息历史
        console.log(
          `[Moonshot ReACT] 📤 Sending ${messages.length} messages to AI:`,
        );
        messages.forEach((msg, idx) => {
          const preview =
            typeof msg.content === "string"
              ? msg.content.substring(0, 100)
              : JSON.stringify(msg.content).substring(0, 100);
          console.log(
            `  [${idx}] role: ${msg.role}, content: ${preview}${
              preview.length >= 100 ? "..." : ""
            }${msg.tool_calls ? `, tool_calls: ${msg.tool_calls.length}` : ""}`,
          );
        });

        // 【非流式请求】调用大模型获取工具调用决策
        // 为什么必须非流式？
        // 1. 需要完整的 JSON 响应来判断 AI 是否要调用工具（检查 tool_calls 字段）
        // 2. 需要解析工具名称和参数（JSON 格式）
        // 3. 流式响应（SSE）是逐字符返回，无法在中途判断和执行工具
        const response = await fetch(fetchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authValue,
          },
          body: JSON.stringify({
            ...requestBody,
            stream: false, // 【关键】强制非流式，确保返回完整 JSON
            messages: messages,
            tools: SHELL_TOOLS, // 告诉 AI 可以使用哪些工具
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          console.error("[Moonshot ReACT] Error:", error);
          return NextResponse.json(
            { error: "API call failed", details: error },
            { status: response.status },
          );
        }

        // 解析 JSON 响应，提取 AI 的决策
        const result = await response.json();
        const assistantMessage = result.choices[0].message;

        // 📥 日志：AI 返回的完整响应
        console.log(`[Moonshot ReACT] 📥 AI Response:`);
        console.log(
          `  - Content: ${
            assistantMessage.content
              ? assistantMessage.content.substring(0, 200) +
                (assistantMessage.content.length > 200 ? "..." : "")
              : "(null)"
          }`,
        );
        console.log(
          `  - Tool Calls: ${assistantMessage.tool_calls?.length || 0}`,
        );
        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          assistantMessage.tool_calls.forEach((tc: any, idx: number) => {
            console.log(
              `    [${idx}] ${tc.function.name}(${tc.function.arguments})`,
            );
          });
        }
        console.log(`  - Finish Reason: ${result.choices[0].finish_reason}`);
        console.log(`  - Usage: ${JSON.stringify(result.usage || {})}`);
        console.log(`${"=".repeat(60)}\n`);

        // ============ 判断1：AI 主动停止（最终答案阶段） ============
        // 如果 AI 没有返回 tool_calls，说明它认为已经有足够信息，直接给出答案
        if (
          !assistantMessage.tool_calls ||
          assistantMessage.tool_calls.length === 0
        ) {
          console.log(`\n${"=".repeat(60)}`);
          console.log(
            "[Moonshot ReACT] ✅ No tool calls, returning final answer",
          );
          console.log(
            `[Moonshot ReACT] 📝 Final answer length: ${
              assistantMessage.content?.length || 0
            } chars`,
          );
          console.log(`${"=".repeat(60)}`);

          // 【流式/非流式分支】根据前端配置决定返回格式
          // 前端配置存储在 requestBody.stream（true=流式打字机效果，false=一次性返回）
          if (requestBody.stream) {
            // 【流式响应】重新发起请求，获取 SSE 格式
            // 为什么要重新请求？
            // 1. 前面的循环用的是非流式（JSON），但前端期望流式（SSE）
            // 2. 直接返回 JSON 会导致前端解析错误，显示原始 JSON 文本
            // 3. 重新请求很快（AI 已有完整上下文，直接输出答案）
            console.log(
              "[Moonshot ReACT] Frontend expects streaming, making streaming request",
            );
            const streamResponse = await fetch(fetchUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: authValue,
              },
              body: JSON.stringify({
                ...requestBody,
                stream: true, // 【关键】这次要求流式响应
                messages: messages, // 使用累积的完整对话历史
              }),
              signal: controller.signal,
            });

            // 检查流式请求是否成功
            if (!streamResponse.ok) {
              const error = await streamResponse.text();
              console.error("[Moonshot ReACT] Streaming error:", error);
              return NextResponse.json(
                {
                  error: true,
                  message: "获取流式响应失败",
                  details: error,
                },
                { status: streamResponse.status },
              );
            }

            // 透传流式响应给前端（保持打字机效果）
            const newHeaders = new Headers(streamResponse.headers);
            newHeaders.delete("www-authenticate");
            newHeaders.set("X-Accel-Buffering", "no");

            return new Response(streamResponse.body, {
              status: streamResponse.status,
              statusText: streamResponse.statusText,
              headers: newHeaders,
            });
          }

          // 【非流式响应】前端不需要打字机效果，直接返回 JSON
          // 过滤掉注入的系统提示，返回真实的对话历史（包括 tool 消息）
          const clientMessages = messages.filter((m) => m !== systemPrompt);
          console.log(
            `[Moonshot ReACT] 📦 Returning ${clientMessages.length} messages to frontend (including tool messages)`,
          );

          return NextResponse.json({
            ...result,
            __react_messages: clientMessages, // 自定义字段：完整对话历史
          });
        }

        // ============ AI 要求调用工具，执行并继续循环 ============
        // 将 AI 的消息加入历史（包含 tool_calls 信息）
        console.log(
          `[Moonshot ReACT] ➕ Adding assistant message to history (with ${assistantMessage.tool_calls.length} tool_calls)`,
        );
        messages.push(assistantMessage);

        // 逐个执行 AI 请求的工具
        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;

          // 解析工具参数（如果有）
          let parsedArgs: any = {};
          if (toolArgs) {
            try {
              parsedArgs =
                typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs;
            } catch (e) {
              console.error(`[Moonshot ReACT] Failed to parse args:`, toolArgs);
            }
          }

          console.log(
            `\n[Moonshot ReACT] 🔧 Executing tool: ${toolName}`,
            Object.keys(parsedArgs).length > 0 ? parsedArgs : "(no args)",
          );

          try {
            // 执行工具，传递参数（如 list_files、current_time 等）
            const toolResult = await executeShellTool(toolName, parsedArgs);

            console.log(`[Moonshot ReACT] ✅ Tool execution completed`);
            console.log(
              `[Moonshot ReACT] 📊 Result preview: ${toolResult.substring(
                0,
                200,
              )}${toolResult.length > 200 ? "..." : ""}`,
            );
            console.log(
              `[Moonshot ReACT] 📊 Result length: ${toolResult.length} chars`,
            );

            // 将工具执行结果加入消息历史，供 AI 下一轮使用
            const toolMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResult,
            };
            messages.push(toolMessage);
            console.log(
              `[Moonshot ReACT] ➕ Added tool result to messages (now ${messages.length} messages total)`,
            );
          } catch (error: any) {
            console.error(`[Moonshot ReACT] ❌ Tool error:`, error);

            // 工具执行失败，也要告诉 AI（让它知道这个工具不可用）
            const errorMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Error: ${error.message}`,
            };
            messages.push(errorMessage);
            console.log(
              `[Moonshot ReACT] ➕ Added error message to messages (now ${messages.length} messages total)`,
            );
          }
        }
        // 继续下一轮循环，让 AI 基于工具结果做出新决策
        console.log(
          `[Moonshot ReACT] 🔄 Loop continues... (messages count: ${messages.length})`,
        );
      }

      // ============ 判断2：达到最大迭代次数（强制最终答案阶段） ============
      // 如果执行到这里，说明 AI 连续调用了 10 次工具还没停止
      // 强制让 AI 基于现有信息给出答案，防止无限循环消耗资源
      console.log(
        "[Moonshot ReACT] Max iterations reached, getting final answer",
      );

      // 【流式/非流式分支】根据前端配置决定返回格式
      // 这里的逻辑和"判断1"相同，只是触发条件不同
      const finalResponse = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authValue,
        },
        body: JSON.stringify({
          ...requestBody,
          stream: requestBody.stream, // 【关键】遵循前端配置（true=SSE流式，false=JSON非流式）
          messages: messages, // 包含所有工具调用历史的完整对话
          // 【关键】不再传 tools 参数，让 AI 知道不能再调用工具，必须给出文本答案
        }),
        signal: controller.signal,
      });

      // 检查请求是否成功
      if (!finalResponse.ok) {
        const error = await finalResponse.text();
        console.error("[Moonshot ReACT] Final answer error:", error);
        return NextResponse.json(
          {
            error: true,
            message:
              "达到最大迭代次数后获取最终答案失败，可能是上下文过长或 API 错误",
            details: error,
          },
          { status: finalResponse.status },
        );
      }

      // 【流式响应】透传 SSE 给前端（打字机效果）
      if (requestBody.stream) {
        const newHeaders = new Headers(finalResponse.headers);
        newHeaders.delete("www-authenticate");
        newHeaders.set("X-Accel-Buffering", "no");

        return new Response(finalResponse.body, {
          status: finalResponse.status,
          statusText: finalResponse.statusText,
          headers: newHeaders,
        });
      }

      // 【非流式响应】返回完整 JSON
      // 过滤掉注入的系统提示，返回真实的对话历史（包括 tool 消息）
      const clientMessages = messages.filter((m) => m !== systemPrompt);
      console.log(
        `[Moonshot ReACT] 📦 Returning ${clientMessages.length} messages to frontend (including tool messages)`,
      );

      const finalResult = await finalResponse.json();
      return NextResponse.json({
        ...finalResult,
        __react_messages: clientMessages, // 自定义字段：完整对话历史
      });
    } else {
      // 非聊天请求，直接代理
      const response = await fetch(fetchUrl, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: authValue,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const newHeaders = new Headers(response.headers);
      newHeaders.delete("www-authenticate");
      newHeaders.set("X-Accel-Buffering", "no");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }
  } catch (error: any) {
    console.error("[Moonshot] Unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    clearTimeout(timeoutId);
  }
}
