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
import { proxyRequestWithLogging } from "./common";

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

  // alibaba use base url or just remove the path
  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Moonshot, "");

  let baseUrl = serverConfig.moonshotUrl || MOONSHOT_BASE_URL;

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

  const fetchUrl = `${baseUrl}${path}`;
  const authValue = req.headers.get("Authorization") ?? "";
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      Authorization: authValue,
    },
    method: req.method,
    body: req.body,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // 记录请求体用于日志
  let requestBodyForLog: any = null;

  // #1815 try to refuse some request to some models
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
          ServiceProvider.Moonshot as string,
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
      console.error(`[Moonshot] filter`, e);
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

  try {
    // 使用通用的代理请求函数（带日志记录）
    return await proxyRequestWithLogging(
      "Moonshot",
      fetchUrl,
      fetchOptions,
      requestBodyForLog,
      "Authorization",
      authValue,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
