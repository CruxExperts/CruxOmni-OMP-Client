import { afterEach, expect, test } from "bun:test";
import { requestJson, requestStream } from "../src/transport.ts";
import type { TransportError } from "../src/transport.ts";
const servers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function fixture(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function expectTransport(promise: Promise<unknown>, code: TransportError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

test("bounded JSON reads reject oversized and over-deep responses", async () => {
  const endpoint = fixture((request) => request.url.endsWith("/large")
    ? new Response(JSON.stringify({ payload: "0123456789" }))
    : new Response(JSON.stringify({ a: { b: { c: { d: 1 } } } }), { headers: { "content-type": "application/json" } }));
  await expectTransport(requestJson(`${endpoint}/large`, "secret", { maxBytes: 8 }), "payload-too-large");
  await expectTransport(requestJson(`${endpoint}/deep`, "secret", { maxDepth: 2 }), "depth-limit");
});

test("safe reads retry one transient status but writes never retry", async () => {
  let reads = 0;
  let writes = 0;
  const endpoint = fixture((request) => {
    if (request.method === "POST") {
      writes += 1;
      return new Response("no", { status: 503 });
    }
    reads += 1;
    return reads === 1 ? new Response("retry", { status: 503, headers: { "retry-after": "0" } }) : Response.json({ ok: true });
  });
  await expect(requestJson(endpoint, "secret", { totalBudgetMs: 2_000 }, undefined, { safeRead: true, maxRetries: 1 })).resolves.toEqual({ ok: true });
  expect(reads).toBe(2);
  await expectTransport(requestJson({ endpoint, method: "POST", body: "{}" }, "secret", { totalBudgetMs: 2_000 }, undefined, { safeRead: true, maxRetries: 1 }), "http");
  expect(writes).toBe(1);
});

test("redirects are rejected before credentials can be forwarded", async () => {
  let redirected = false;
  let endpoint = "";
  endpoint = fixture((request) => {
    if (request.url.endsWith("/start")) return new Response(null, { status: 302, headers: { location: `${endpoint}/sink` } });
    redirected = request.headers.has("authorization");
    return Response.json({ ok: true });
  });
  await expectTransport(requestJson(`${endpoint}/start`, "secret"), "redirect");
  expect(redirected).toBe(false);
});

test("stream responses remain bounded and cancellation is typed", async () => {
  const endpoint = fixture(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
      controller.close();
    },
  })));
  const response = await requestStream(endpoint, "secret", { maxBytes: 5 });
  await expectTransport(response.text(), "payload-too-large");
  const controller = new AbortController();
  controller.abort();
  await expectTransport(requestJson(endpoint, "secret", undefined, controller.signal), "aborted");
});
