import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { MOONSHOT_BASE_URL } from "@/app/constant";
import { executeShellTool, SHELL_TOOLS } from "@/app/tools/shell";

// 必须使用nodejs runtime以支持child_process
export const runtime = "nodejs";
const serverConfig = getServerSideConfig();
export async function POST(req: NextRequest) {
  try {
    const requestBody = await req.json();
    const MAX_ITERATIONS = 3;
    let messages = [...requestBody.messages];
    let iterations = 0;
    const baseUrl = (serverConfig.moonshotUrl || MOONSHOT_BASE_URL).replace(
      /\/$/,
      "",
    );
    const apiKey = serverConfig.moonshotApiKey;

    console.log("[ReACT API] Starting with messages:", messages.length);
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[ReACT API] Iteration ${iterations}/${MAX_ITERATIONS}`);

      // 调用Kimi API
      console.log(requestBody.model);
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: requestBody.model || "kimi-k2-0905-preview",
          messages: messages,
          tools: SHELL_TOOLS,
          temperature: requestBody.temperature || 0.7,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[ReACT API] Error:", error);
        return NextResponse.json(
          { error: "API call failed", details: error },
          { status: response.status },
        );
      }

      const result = await response.json();
      const assistantMessage = result.choices[0].message;

      console.log("[ReACT API] Response:", {
        content: assistantMessage.content?.substring(0, 100),
        tool_calls: assistantMessage.tool_calls?.length || 0,
      });

      // 无工具调用，返回结果
      if (
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        console.log("[ReACT API] No tool calls, returning final answer");
        return NextResponse.json(result);
      }

      // 添加助手消息
      messages.push(assistantMessage);

      // 执行工具
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        console.log(`[ReACT API] Executing tool: ${toolName}`);
        try {
          const toolResult = await executeShellTool(toolName);
          console.log(
            `[ReACT API] Tool result (${toolName}):`,
            toolResult.substring(0, 200),
          );
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        } catch (error: any) {
          console.error(`[ReACT API] Tool error:`, error);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${error.message}`,
          });
        }
      }
    }

    // 达到最大迭代次数
    console.log("[ReACT API] Max iterations reached");
    const finalResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: requestBody.model || "kimi-k2-0905-preview",
        messages: messages,
        temperature: requestBody.temperature || 0.7,
      }),
    });

    const finalResult = await finalResponse.json();
    console.log("[ReACT API] Response:", finalResult);
    return NextResponse.json(finalResult);
  } catch (error: any) {
    console.error("[ReACT API] Unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
