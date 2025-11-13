import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "../config/server";
import { OPENAI_BASE_URL, ServiceProvider } from "../constant";
import { cloudflareAIGatewayUrl } from "../utils/cloudflare";
import { getModelProvider, isModelNotavailableInServer } from "../utils/model";

const serverConfig = getServerSideConfig();

// ==================== 日志配置 ====================
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // debug, info, error
const shouldLogDebug = LOG_LEVEL === "debug";
const shouldLogInfo = LOG_LEVEL === "debug" || LOG_LEVEL === "info";

// ==================== 服务端日志功能 ====================
/**
 * 通用代理请求函数（带日志记录）
 * @param providerName AI供应商名称
 * @param fetchUrl 目标URL
 * @param fetchOptions fetch配置
 * @param requestBody 请求体（用于日志）
 * @param authHeaderName 认证头名称
 * @param authValue 认证值
 */
export async function proxyRequestWithLogging(
  providerName: string,
  fetchUrl: string,
  fetchOptions: RequestInit,
  requestBody: any,
  authHeaderName: string = "Authorization",
  authValue?: string,
) {
  // ==================== 服务端日志 ====================
  if (shouldLogInfo) {
    console.log("\n==================== 📤 发送给大模型 ====================");
    console.log("[Provider]", providerName);
    console.log("[URL]", fetchUrl);
    console.log("[Method]", fetchOptions.method || "POST");

    if (shouldLogDebug) {
      console.log("[Headers]", {
        "Content-Type": "application/json",
        Authorization: authValue ? "[REDACTED]" : undefined,
      });
      if (requestBody) {
        console.log("[Request Body]", JSON.stringify(requestBody, null, 2));
      }
    }
    console.log("========================================================\n");
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    if (shouldLogInfo) {
      console.log(
        "\n==================== 📥 收到大模型响应 ====================",
      );
      console.log("[Provider]", providerName);
      console.log("[Status]", res.status, res.statusText);
      console.log("[Content-Type]", res.headers.get("content-type"));
    }

    // 处理响应头
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");
    newHeaders.delete("content-encoding");

    // 判断是否为流式响应
    const isStreamResponse =
      newHeaders.get("content-type")?.includes("text/event-stream") ||
      requestBody?.stream === true;

    if (shouldLogInfo) {
      if (isStreamResponse) {
        console.log("[Response Type] Stream (流式响应)");
        console.log(
          "========================================================\n",
        );
      } else {
        console.log("[Response Type] Non-Stream (非流式响应)");
      }
    }

    // 如果是流式响应，拦截并记录chunk
    if (isStreamResponse && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunkCount = 0;
      if (shouldLogDebug) {
        console.log(
          "==================== 📊 流式响应内容 ====================",
        );
      }

      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (shouldLogInfo) {
                  console.log(`\n[Stream End] 总计接收 ${chunkCount} 个chunks`);
                  console.log(
                    "========================================================\n",
                  );
                }
                controller.close();
                break;
              }

              const chunkText = decoder.decode(value, { stream: true });
              chunkCount++;

              // 只记录前3个chunk（仅 debug 模式）
              if (shouldLogDebug) {
                if (chunkCount <= 3) {
                  console.log(
                    `[Chunk ${chunkCount}]`,
                    chunkText.substring(0, 200),
                  );
                } else if (chunkCount === 4) {
                  console.log("[Chunk 4+] ... (省略中间chunks，避免日志过多)");
                }
              }

              controller.enqueue(value);
            }
          } catch (error) {
            console.error(
              "\n==================== ❌ 流式响应错误 ====================",
            );
            console.error("[Error]", error);
            console.error(
              "========================================================\n",
            );
            controller.error(error);
          }
        },
      });

      return new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    } else {
      // 非流式响应，记录完整响应体（仅 debug 模式）
      if (shouldLogDebug) {
        try {
          const responseClone = res.clone();
          const responseBody = await responseClone.json();
          console.log("[Response Body]", JSON.stringify(responseBody, null, 2));
          console.log(
            "========================================================\n",
          );
        } catch (e) {
          console.log("[Response Body] (无法解析为JSON，可能是二进制数据)");
          console.log(
            "========================================================\n",
          );
        }
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }
  } catch (error) {
    console.error("\n==================== ❌ 请求错误 ====================");
    console.error("[Provider]", providerName);
    console.error("[URL]", fetchUrl);
    console.error("[Error]", error);
    console.error("========================================================\n");
    throw error;
  }
}

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();
  const isAzure = req.nextUrl.pathname.includes("azure/deployments");
  var authValue,
    authHeaderName = "";
  if (isAzure) {
    authValue =
      req.headers
        .get("Authorization")
        ?.trim()
        .replaceAll("Bearer ", "")
        .trim() ?? "";

    authHeaderName = "api-key";
  } else {
    authValue = req.headers.get("Authorization") ?? "";
    authHeaderName = "Authorization";
  }

  let path = `${req.nextUrl.pathname}`.replaceAll("/api/openai/", "");

  let baseUrl =
    (isAzure ? serverConfig.azureUrl : serverConfig.baseUrl) || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (isAzure) {
    const azureApiVersion =
      req?.nextUrl?.searchParams?.get("api-version") ||
      serverConfig.azureApiVersion;
    baseUrl = baseUrl.split("/deployments").shift() as string;
    path = `${req.nextUrl.pathname.replaceAll(
      "/api/azure/",
      "",
    )}?api-version=${azureApiVersion}`;

    // Forward compatibility:
    // if display_name(deployment_name) not set, and '{deploy-id}' in AZURE_URL
    // then using default '{deploy-id}'
    if (serverConfig.customModels && serverConfig.azureUrl) {
      const modelName = path.split("/")[1];
      let realDeployName = "";
      serverConfig.customModels
        .split(",")
        .filter((v) => !!v && !v.startsWith("-") && v.includes(modelName))
        .forEach((m) => {
          const [fullName, displayName] = m.split("=");
          const [_, providerName] = getModelProvider(fullName);
          if (providerName === "azure" && !displayName) {
            const [_, deployId] = (serverConfig?.azureUrl ?? "").split(
              "deployments/",
            );
            if (deployId) {
              realDeployName = deployId;
            }
          }
        });
      if (realDeployName) {
        console.log("[Replace with DeployId", realDeployName);
        path = path.replaceAll(modelName, realDeployName);
      }
    }
  }

  const fetchUrl = cloudflareAIGatewayUrl(`${baseUrl}/${path}`);
  console.log("fetchUrl", fetchUrl);
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      [authHeaderName]: authValue,
      ...(serverConfig.openaiOrgId && {
        "OpenAI-Organization": serverConfig.openaiOrgId,
      }),
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // 记录请求体用于日志
  let requestBodyForLog: any = null;

  // #1815 try to refuse gpt4 request
  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };
      requestBodyForLog = jsonBody; // 保存用于日志

      // not undefined and is false
      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          [
            ServiceProvider.OpenAI,
            ServiceProvider.Azure,
            jsonBody?.model as string, // support provider-unspecified model
          ],
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter", e);
    }
  } else if (req.body) {
    // 如果没有customModels检查，仍然需要克隆body用于日志
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;
      requestBodyForLog = JSON.parse(clonedBody);
    } catch (e) {
      console.error("[Logger] Failed to clone request body", e);
    }
  }

  // ==================== 服务端日志 ====================
  const providerName = isAzure ? "Azure" : "OpenAI";

  console.log("\n==================== 📤 发送给大模型 ====================");
  console.log("[Provider]", providerName);
  console.log("[URL]", fetchUrl);
  console.log("[Method]", req.method);
  console.log("[Headers]", {
    "Content-Type": "application/json",
    Authorization: authValue ? "[REDACTED]" : undefined,
  });
  if (requestBodyForLog) {
    console.log("[Request Body]", JSON.stringify(requestBodyForLog, null, 2));
  }
  console.log("========================================================\n");

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    if (shouldLogInfo) {
      console.log(
        "\n==================== 📥 收到大模型响应 ====================",
      );
      console.log("[Provider]", providerName);
      console.log("[Status]", res.status, res.statusText);
      console.log("[Content-Type]", res.headers.get("content-type"));
    }

    // Extract the OpenAI-Organization header from the response
    const openaiOrganizationHeader = res.headers.get("OpenAI-Organization");

    // Check if serverConfig.openaiOrgId is defined and not an empty string
    if (serverConfig.openaiOrgId && serverConfig.openaiOrgId.trim() !== "") {
      // If openaiOrganizationHeader is present, log it; otherwise, log that the header is not present
      console.log("[Org ID]", openaiOrganizationHeader);
    } else {
      console.log("[Org ID] is not set up.");
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // Conditionally delete the OpenAI-Organization header from the response if [Org ID] is undefined or empty (not setup in ENV)
    // Also, this is to prevent the header from being sent to the client
    if (!serverConfig.openaiOrgId || serverConfig.openaiOrgId.trim() === "") {
      newHeaders.delete("OpenAI-Organization");
    }

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    // 判断是否为流式响应
    const isStreamResponse =
      newHeaders.get("content-type")?.includes("text/event-stream") ||
      requestBodyForLog?.stream === true;

    if (shouldLogInfo) {
      if (isStreamResponse) {
        console.log("[Response Type] Stream (流式响应)");
        console.log(
          "========================================================\n",
        );
      } else {
        console.log("[Response Type] Non-Stream (非流式响应)");
      }
    }

    // 如果是流式响应，拦截并记录chunk
    if (isStreamResponse && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunkCount = 0;
      let totalContent = "";

      console.log("==================== 📊 流式响应内容 ====================");

      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (shouldLogInfo) {
                  console.log(`\n[Stream End] 总计接收 ${chunkCount} 个chunks`);
                  console.log(
                    "========================================================\n",
                  );
                }
                controller.close();
                break;
              }

              // 记录chunk
              const chunkText = decoder.decode(value, { stream: true });
              chunkCount++;

              // 只记录前3个chunk和最后的内容（避免日志太长）
              if (chunkCount <= 3) {
                console.log(
                  `[Chunk ${chunkCount}]`,
                  chunkText.substring(0, 200),
                );
              } else if (chunkCount === 4) {
                console.log("[Chunk 4+] ... (省略中间chunks，避免日志过多)");
              }

              // 传递给客户端
              controller.enqueue(value);
            }
          } catch (error) {
            console.error(
              "\n==================== ❌ 流式响应错误 ====================",
            );
            console.error("[Error]", error);
            console.error(
              "========================================================\n",
            );
            controller.error(error);
          }
        },
      });

      return new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    } else {
      // 非流式响应，记录完整响应体（仅 debug 模式）
      if (shouldLogDebug) {
        try {
          const responseClone = res.clone();
          const responseBody = await responseClone.json();
          console.log("[Response Body]", JSON.stringify(responseBody, null, 2));
          console.log(
            "========================================================\n",
          );
        } catch (e) {
          console.log("[Response Body] (无法解析为JSON，可能是二进制数据)");
          console.log(
            "========================================================\n",
          );
        }
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }
  } catch (error) {
    // 记录请求错误
    console.error("\n==================== ❌ 请求错误 ====================");
    console.error("[Provider]", providerName);
    console.error("[URL]", fetchUrl);
    console.error("[Error]", error);
    console.error("========================================================\n");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
