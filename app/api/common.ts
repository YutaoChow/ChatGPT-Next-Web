import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "../config/server";
import { DEFAULT_MODELS, OPENAI_BASE_URL, GEMINI_BASE_URL } from "../constant";
import { collectModelTable } from "../utils/model";
import { makeAzurePath } from "../azure";

const serverConfig = getServerSideConfig();

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();

  var authValue,
    authHeaderName = "";
  if (serverConfig.isAzure) {
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

  let path = `${req.nextUrl.pathname}${req.nextUrl.search}`.replaceAll(
    "/api/openai/",
    "",
  );

  let baseUrl =
    serverConfig.azureUrl || serverConfig.baseUrl || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);
  // this fix [Org ID] undefined in server side if not using custom point
  if (serverConfig.openaiOrgId !== undefined) {
    console.log("[Org ID]", serverConfig.openaiOrgId);
  }

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (serverConfig.isAzure) {
    if (!serverConfig.azureApiVersion) {
      return NextResponse.json({
        error: true,
        message: `missing AZURE_API_VERSION in server env vars`,
      });
    }
    path = makeAzurePath(path, serverConfig.azureApiVersion);
  }

  const fetchUrl = `${baseUrl}/${path}`;
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

  // #1815 try to refuse gpt4 request
  if (serverConfig.customModels && req.body) {
    try {
      const modelTable = collectModelTable(
        DEFAULT_MODELS,
        serverConfig.customModels,
      );
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (modelTable[jsonBody?.model ?? ""].available === false) {
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
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const Authorization2Token: any = {};
export async function requestGithub(req: NextRequest) {
  const controller = new AbortController();

  var authBearerValue,
    authValue,
    authHeaderName = "Authorization",
    token;

  authBearerValue = req.headers.get("Authorization") ?? "";
  authValue = authBearerValue
    ? authBearerValue.trim().replaceAll("Bearer ", "").trim()
    : "";

  token =
    Authorization2Token[authValue] ?? (await getGithubCopilotToken(authValue));

  console.log("[Github Copilot token]", token);

  if (!token) {
    return NextResponse.json(
      {
        error: true,
        msg: "you github plugin token is not allowed to request",
      },
      {
        status: 403,
      },
    );
  }
  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  const fetchUrl = "https://api.githubcopilot.com/chat/completions";
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Editor-Version": "vscode/1.83.1",
      "Editor-Plugin-Version": "copilot-chat/0.8.0",
      "Openai-Organization": "github-copilot",
      "User-Agent": "GitHubCopilotChat/0.8.0",
      [authHeaderName]: `Bearer ${token}`,
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };
  let res;
  try {
    console.log("[Github Copilot]", `fetchOptions: ${fetchOptions}`);
    res = await fetch(fetchUrl, fetchOptions);

    if (res?.status === 401) {
      console.log("[Github Copilot]", "token过期，重新获取");
      token = Authorization2Token[authValue] =
        await getGithubCopilotToken(authValue);
      res = await fetch(fetchUrl, {
        ...fetchOptions,
        [authHeaderName]: `Bearer ${token}`,
      });
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");
    // if (reqJson.stream) {
    newHeaders.set("Content-type", "text/event-stream");
    // }
    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

//通过Github Plugin Token获取Github Copilot的token
async function getGithubCopilotToken(pluginToken: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = "https://api.github.com/copilot_internal/v2/token";

  console.log("[Github Copilot pluginToken]", pluginToken);

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Editor-Version": "vscode/1.83.1",
      "Editor-Plugin-Version": "copilot-chat/0.8.0",
      "Openai-Organization": "github-copilot",
      "User-Agent": "GitHubCopilotChat/0.8.0",
      Authorization: `token ${pluginToken}`,
    },
    method: "GET",
    signal: controller.signal,
  };
  try {
    const res = await fetch(fetchUrl, fetchOptions);
    console.log("[Github Copilot]", `res status ${res.status}`);
    return res.json().then((data) => {
      return data.token;
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
