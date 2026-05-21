const { log, err } = require("../logger");
const { fetchRouter, pipeSSE } = require("./base");

// Map Copilot endpoint → 9Router path
const URL_MAP = {
  "/chat/completions": "/v1/chat/completions",
  "/v1/messages":      "/v1/messages",
  "/responses":        "/v1/responses",
};

function resolveRouterPath(reqUrl) {
  for (const [pattern, routerPath] of Object.entries(URL_MAP)) {
    if (reqUrl.includes(pattern)) return routerPath;
  }
  return "/v1/chat/completions";
}

/**
 * Pipe SSE stream to client, logging (but still forwarding) chunks with missing/empty choices.
 */
async function pipeSSEWithChoicesCheck(routerRes, res) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const isSSE = ct.includes("text/event-stream");
  if (!isSSE) {
    await pipeSSE(routerRes, res);
    return;
  }

  const status = routerRes.status || 200;
  res.writeHead(status, {
    "Content-Type": ct,
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (!routerRes.body) {
    res.end();
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) { res.end(); break; }
    const text = decoder.decode(value, { stream: true });
    res.write(text);

    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        if (chunk.choices !== undefined && chunk.choices.length === 0) {
          log(`[copilot] WARN malformed chunk — empty choices array: ${JSON.stringify(chunk)}`);
        }
      } catch { /* not JSON, skip */ }
    }
  }
}

/**
 * Intercept Copilot request — replace model and forward to matching 9Router endpoint
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    body.model = mappedModel;
    const routerPath = resolveRouterPath(req.url);
    const routerRes = await fetchRouter(body, routerPath, req.headers);
    await pipeSSEWithChoicesCheck(routerRes, res);
  } catch (error) {
    err(`[copilot] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
