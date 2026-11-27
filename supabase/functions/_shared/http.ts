// CORS, JSON responses and error handling shared by every Edge Function.
// CORS is allowed only for origins listed in the ALLOWED_ORIGINS secret (comma-separated),
// e.g. "https://your-org.github.io". Local dev origins are added when ALLOW_LOCALHOST=true.

const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"];

function allowedOrigins(): string[] {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (Deno.env.get("ALLOW_LOCALHOST") === "true") configured.push(...LOCAL_ORIGINS);
  return configured;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/**
 * Wraps a handler: answers CORS preflight, rejects disallowed browser origins and non-POST requests,
 * parses the JSON body and turns thrown errors into JSON responses. Never logs request bodies.
 */
export function serve(name: string, handler: (req: Request, body: unknown) => Promise<unknown>) {
  Deno.serve(async (req) => {
    const origin = req.headers.get("Origin");
    const originOk = !origin || allowedOrigins().includes(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: originOk ? 204 : 403, headers: corsHeaders(req) });
    }
    if (!originOk) return json(req, 403, { error: "origin not allowed" });
    if (req.method !== "POST") return json(req, 405, { error: "method not allowed" });

    let body: unknown = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(req, 400, { error: "invalid JSON body" });
    }

    try {
      const result = await handler(req, body);
      return json(req, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return json(req, err.status, { error: err.message, ...err.extra });
      // Log only the error type and message: never request bodies, answers or flags.
      console.error(`[${name}] unexpected error:`, err instanceof Error ? err.message : String(err));
      return json(req, 500, { error: "internal error" });
    }
  });
}
