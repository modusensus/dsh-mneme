import { URL } from "node:url";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Collect the request body as text (tolerant of empty/invalid bodies). */
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

function parseBody(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

export function createApi(ctx, service, settings, commands) {
  const disposers = [];

  const register = (route) => {
    disposers.push(ctx.webServer.register(route));
  };

  // /api/dsh-mneme prefix fallback → 404 JSON for unknown sub-paths
  register({
    kind: "prefix",
    path: "/api/dsh-mneme",
    handler(req, res) {
      sendJson(res, 404, { error: "not-found" });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/list",
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
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/search",
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
  });

  // --- user profile ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req).then((text) => {
            const body = parseBody(text);
            settings.setProfile(typeof body.profile === "string" ? body.profile : "");
            sendJson(res, 200, { profile: settings.getProfile() });
          });
        }
        sendJson(res, 200, { profile: settings.getProfile() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- rules ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/rules",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req).then((text) => {
            const body = parseBody(text);
            settings.setRules(Array.isArray(body.rules) ? body.rules : []);
            sendJson(res, 200, { rules: settings.getRules() });
          });
        }
        sendJson(res, 200, { rules: settings.getRules() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- custom commands ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/commands",
    handler(req, res) {
      try {
        if (req.method === "POST") {
          return readBody(req).then((text) => {
            const body = parseBody(text);
            try {
              const command = commands.add({
                name: body.name,
                description: body.description,
                instruction: body.instruction
              });
              sendJson(res, 200, { command });
            } catch (error) {
              sendJson(res, 400, { error: error.message });
            }
          });
        }
        if (req.method === "DELETE") {
          const url = new URL(req.url, "http://localhost");
          const id = url.searchParams.get("id");
          const removed = id ? commands.remove(id) : false;
          sendJson(res, 200, { removed });
          return;
        }
        sendJson(res, 200, { commands: commands.list() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  return {
    routes: 6,
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
