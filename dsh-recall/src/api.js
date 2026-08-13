import { URL } from "node:url";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function createApi(ctx, service) {
  const disposers = [];

  // /api/dsh-recall prefix fallback → 404 JSON for unknown sub-paths
  disposers.push(ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-recall",
    handler(req, res) {
      sendJson(res, 404, { error: "not-found" });
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-recall/list",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const type = url.searchParams.get("type") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const items = service.toApiList(service.list({ type, limit, offset }));
        sendJson(res, 200, { items, total: service.count(type) });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-recall/search",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const items = service.toApiList(service.search(q, { limit }));
        sendJson(res, 200, { items });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  }));

  return {
    routes: 3,
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
