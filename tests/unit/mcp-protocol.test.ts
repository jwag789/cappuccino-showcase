import { beforeAll, describe, expect, it } from "vitest";

// checkOrigin resolves the allowed origin through siteUrl(), which reads the
// environment on every call — set before the module is imported so there is no
// dependence on import order.
process.env.APP_URL = "https://cappuccino.test";

let protocol: typeof import("@/lib/mcp/protocol");

beforeAll(async () => {
  protocol = await import("@/lib/mcp/protocol");
});

const VERSION = "2026-07-28";

function meta(overrides: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "TestClient", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

function post(headers: Record<string, string>): Request {
  return new Request("https://cappuccino.test/api/mcp", { method: "POST", headers });
}

function callHeaders(overrides: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "mcp-protocol-version": VERSION,
    "mcp-method": "tools/call",
    "mcp-name": "list_conflicts",
    ...overrides,
  };
}

function callBody(params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_conflicts", arguments: {}, _meta: meta(), ...params },
  };
}

/** The JSON-RPC error code inside a rejection, whatever its shape. */
function code(rejection: unknown): number | undefined {
  const body = (rejection as { body?: { error?: { code?: number } } }).body;
  return body?.error?.code;
}

describe("parseRequest", () => {
  it("accepts a well-formed tools/call", () => {
    const parsed = protocol.parseRequest(post(callHeaders()), callBody());
    expect(protocol.isRejection(parsed)).toBe(false);
    if (protocol.isRejection(parsed)) return;
    expect(parsed.method).toBe("tools/call");
    expect(parsed.clientName).toBe("TestClient");
  });

  // The reason header validation exists at all: a gateway may route or
  // authorize on the header while the server executes the body, so the two
  // disagreeing is a security bug, not a formatting one.
  it("rejects a Mcp-Name header that disagrees with the body", () => {
    const parsed = protocol.parseRequest(
      post(callHeaders({ "mcp-name": "check_plan" })),
      callBody()
    );
    expect(code(parsed)).toBe(protocol.ERROR.headerMismatch);
  });

  it("rejects a Mcp-Method header that disagrees with the body", () => {
    const parsed = protocol.parseRequest(post(callHeaders({ "mcp-method": "tools/list" })), callBody());
    expect(code(parsed)).toBe(protocol.ERROR.headerMismatch);
  });

  it.each(["mcp-method", "mcp-name", "mcp-protocol-version"])("requires %s", (header) => {
    const headers = callHeaders();
    delete (headers as Record<string, string>)[header];
    expect(code(protocol.parseRequest(post(headers), callBody()))).toBe(protocol.ERROR.headerMismatch);
  });

  // A tool name outside plain ASCII travels Base64-wrapped, and a server that
  // compared the raw header would reject every such call as a mismatch.
  it("decodes the Base64 sentinel before comparing Mcp-Name", () => {
    const name = "search_artifacts_世界";
    const encoded = `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;
    const parsed = protocol.parseRequest(
      post(callHeaders({ "mcp-name": encoded })),
      callBody({ name })
    );
    expect(protocol.isRejection(parsed)).toBe(false);
  });

  it("requires the protocol version in _meta", () => {
    const body = callBody({ _meta: meta({ "io.modelcontextprotocol/protocolVersion": undefined }) });
    expect(code(protocol.parseRequest(post(callHeaders()), body))).toBe(protocol.ERROR.invalidParams);
  });

  it("requires client capabilities in _meta", () => {
    const body = callBody({ _meta: meta({ "io.modelcontextprotocol/clientCapabilities": undefined }) });
    expect(code(protocol.parseRequest(post(callHeaders()), body))).toBe(protocol.ERROR.invalidParams);
  });

  it("rejects a version header that disagrees with _meta", () => {
    const parsed = protocol.parseRequest(
      post(callHeaders({ "mcp-protocol-version": "2025-11-25" })),
      callBody()
    );
    expect(code(parsed)).toBe(protocol.ERROR.headerMismatch);
  });

  it("reports its supported versions when asked for one it does not serve", () => {
    const body = callBody({ _meta: meta({ "io.modelcontextprotocol/protocolVersion": "1900-01-01" }) });
    const parsed = protocol.parseRequest(
      post(callHeaders({ "mcp-protocol-version": "1900-01-01" })),
      body
    );
    expect(code(parsed)).toBe(protocol.ERROR.unsupportedProtocolVersion);
    const data = (parsed as { body: { error: { data: { supported: string[]; requested: string } } } }).body
      .error.data;
    expect(data.supported).toContain(VERSION);
    expect(data.requested).toBe("1900-01-01");
  });

  // A legacy client sends no MCP headers and no `_meta`, so every other check
  // here would reject it for something it was never going to send. It also has
  // no fall-forward mechanism, which makes this message the whole diagnostic.
  it("answers a legacy initialize with the versions it does support", () => {
    const parsed = protocol.parseRequest(
      post({ "content-type": "application/json" }),
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } }
    );
    expect(code(parsed)).toBe(protocol.ERROR.unsupportedProtocolVersion);
    const body = (parsed as {
      body: { id: number; error: { message: string; data: { supported: string[] } } };
    }).body;
    // The id is echoed so the client can match the failure to its own request.
    expect(body.id).toBe(0);
    expect(body.error.data.supported).toContain(VERSION);
    expect(body.error.message).toMatch(/initialize handshake/);
  });

  it("does not require Mcp-Name for methods that carry no name", () => {
    const headers = {
      "mcp-protocol-version": VERSION,
      "mcp-method": "tools/list",
    };
    const body = { jsonrpc: "2.0", id: "a", method: "tools/list", params: { _meta: meta() } };
    expect(protocol.isRejection(protocol.parseRequest(post(headers), body))).toBe(false);
  });
});

describe("checkOrigin", () => {
  // Non-browser clients send no Origin at all; a wrong one is a page on another
  // site trying to use a visitor's credentials.
  it("allows a request with no Origin", () => {
    expect(protocol.checkOrigin(post(callHeaders()))).toBeNull();
  });

  it("allows our own origin", () => {
    expect(
      protocol.checkOrigin(post(callHeaders({ origin: "https://cappuccino.test" })))
    ).toBeNull();
  });

  it("rejects any other origin with 403", () => {
    const rejection = protocol.checkOrigin(post(callHeaders({ origin: "https://evil.example" })));
    expect(rejection?.status).toBe(403);
  });
});

describe("isNotification", () => {
  it("is true for a method with no id", () => {
    expect(protocol.isNotification({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBe(true);
  });

  it("is false for a request", () => {
    expect(protocol.isNotification({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(false);
  });
});

describe("resultBody", () => {
  // Both are mandatory in this revision: there is no handshake in which the
  // server could have identified itself, and no result without a resultType.
  it("carries resultType and serverInfo", () => {
    const body = protocol.resultBody(7, { tools: [] }) as {
      id: number;
      result: { resultType: string; _meta: Record<string, unknown> };
    };
    expect(body.id).toBe(7);
    expect(body.result.resultType).toBe("complete");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual(protocol.SERVER_INFO);
  });
});
