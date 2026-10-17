import { siteUrl } from "../site";

/**
 * The wire rules of MCP revision 2026-07-28, kept apart from what the tools do.
 *
 * Two things about this revision shape everything here:
 *
 *  1. There are no sessions. The `initialize` handshake and `Mcp-Session-Id`
 *     are gone; every request carries its own protocol version, client identity
 *     and capabilities in `_meta`. That is why a serverless route can serve
 *     this protocol at all — there is no state to keep between requests and no
 *     sticky routing to arrange.
 *
 *  2. Selected body fields are mirrored into HTTP headers (`Mcp-Method`,
 *     `Mcp-Name`) so gateways can route without parsing the body. The body
 *     remains the source of truth, and a server that reads the body **must**
 *     reject any request where the two disagree — otherwise a load balancer
 *     could authorise one thing while the server executes another.
 *
 * Written against the specification rather than an SDK: there is no MCP package
 * in this project, the protocol is JSON-RPC over one POST, and a dependency
 * that has to track the spec is a worse liability here than sixty lines of
 * header validation.
 */

export const PROTOCOL_VERSION = "2026-07-28";

/** Versions this server will serve. Reported by `server/discover` and in errors. */
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];

export const SERVER_INFO = { name: "cappuccino", version: "1.0.0" } as const;

/** MCP-defined codes, from the range the spec reserves for itself. */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export type JsonRpcId = string | number;

export type McpRequest = {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  clientName: string | null;
};

/** An HTTP status paired with the JSON-RPC error body that explains it. */
export type Rejection = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export function errorBody(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): unknown {
  return { jsonrpc: "2.0", ...(id === null ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * A successful result.
 *
 * `resultType` is mandatory in this revision — it is what lets a client tell a
 * finished answer from one that needs more input — and `serverInfo` rides along
 * in `_meta` because there is no handshake in which to have said it.
 */
export function resultBody(id: JsonRpcId, result: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    },
  };
}

/**
 * Decodes the Base64 sentinel a client uses for header values that cannot be
 * written as plain ASCII: `=?base64?<payload>?=`.
 *
 * Servers must decode before comparing a header to its body value, or a tool
 * name with a non-ASCII character in it would always look like a mismatch.
 */
export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    return Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return value;
  }
}

/**
 * Rejects a browser that is not our own origin.
 *
 * Required against DNS rebinding: without it a page on any site could drive
 * this endpoint using a visitor's credentials. Non-browser clients send no
 * `Origin` at all, which is why an absent header is fine and a wrong one is
 * not.
 */
export function checkOrigin(request: Request): Rejection | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  let allowed: string;
  try {
    allowed = new URL(siteUrl()).origin;
  } catch {
    return null;
  }
  if (origin === allowed) return null;

  return {
    status: 403,
    body: errorBody(null, ERROR.invalidRequest, "Origin not allowed."),
  };
}

/** Methods that mirror a name or URI into `Mcp-Name`. */
const NAME_HEADER_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

/**
 * Validates one POST body against the transport's rules and returns either the
 * request to dispatch or the rejection to send back.
 *
 * The order matters: a malformed envelope has no usable id to answer with, the
 * headers are checked before the version because a mismatched header means the
 * request cannot be trusted at all, and the method is resolved last so that an
 * unknown method on an unsupported version reports the version.
 */
export function parseRequest(request: Request, body: unknown): McpRequest | Rejection {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: errorBody(null, ERROR.invalidRequest, "Expected a JSON-RPC request object.") };
  }

  const message = body as Record<string, unknown>;
  const id = message.id;
  const method = message.method;

  if (typeof method !== "string") {
    return { status: 400, body: errorBody(null, ERROR.invalidRequest, "Missing `method`.") };
  }

  // A client still opening with `initialize` speaks a revision from before this
  // one, and those clients have no way to fall forward: there is no negotiation
  // step in which they could learn what this server does support. Whatever is
  // said here may be the only diagnostic a person ever sees, so it names the
  // versions and says what to do, rather than reporting a missing header the
  // client was never going to send.
  if (method === "initialize") {
    return {
      status: 400,
      body: errorBody(
        typeof id === "string" || typeof id === "number" ? id : null,
        ERROR.unsupportedProtocolVersion,
        `This server implements MCP ${SUPPORTED_VERSIONS.join(", ")} only, which replaced the initialize handshake with per-request metadata. The client is using an earlier revision. Upgrade it, or enable its newer-protocol negotiation.`,
        { supported: SUPPORTED_VERSIONS, requested: "initialize (pre-2026-07-28)" }
      ),
    };
  }
  if (typeof id !== "string" && typeof id !== "number") {
    // No id means a notification. This revision defines none over HTTP, and the
    // caller handles that case before reaching here.
    return { status: 400, body: errorBody(null, ERROR.invalidRequest, "Missing `id`.") };
  }

  const params =
    message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : {};

  // --- Headers must agree with the body ------------------------------------
  const headerMethod = request.headers.get("mcp-method");
  if (!headerMethod) {
    return headerMismatch(id, "Missing required header `Mcp-Method`.");
  }
  if (headerMethod !== method) {
    return headerMismatch(
      id,
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${method}'.`
    );
  }

  const nameField = NAME_HEADER_METHODS[method];
  if (nameField) {
    const headerName = request.headers.get("mcp-name");
    if (!headerName) {
      return headerMismatch(id, "Missing required header `Mcp-Name`.");
    }
    const bodyName = params[nameField];
    if (typeof bodyName !== "string") {
      return {
        status: 400,
        body: errorBody(id, ERROR.invalidParams, `Missing \`params.${nameField}\`.`),
      };
    }
    if (decodeHeaderValue(headerName) !== bodyName) {
      return headerMismatch(
        id,
        `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${bodyName}'.`
      );
    }
  }

  // --- Per-request metadata -------------------------------------------------
  const meta =
    params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {};

  const bodyVersion = meta[META_VERSION];
  if (typeof bodyVersion !== "string") {
    return {
      status: 400,
      body: errorBody(id, ERROR.invalidParams, `Missing required \`_meta["${META_VERSION}"]\`.`),
    };
  }
  if (meta[META_CAPABILITIES] === undefined) {
    return {
      status: 400,
      body: errorBody(id, ERROR.invalidParams, `Missing required \`_meta["${META_CAPABILITIES}"]\`.`),
    };
  }

  const headerVersion = request.headers.get("mcp-protocol-version");
  if (!headerVersion) {
    // Older clients did not send this header. Rejecting rather than guessing a
    // legacy version: this server implements one revision, and a client that
    // gets a modern JSON-RPC error back can tell that from a bare 400 and
    // retry correctly.
    return headerMismatch(id, "Missing required header `MCP-Protocol-Version`.");
  }
  if (headerVersion !== bodyVersion) {
    return headerMismatch(
      id,
      `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match \`_meta["${META_VERSION}"]\` value '${bodyVersion}'.`
    );
  }

  if (!SUPPORTED_VERSIONS.includes(bodyVersion)) {
    return {
      status: 400,
      body: errorBody(id, ERROR.unsupportedProtocolVersion, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS,
        requested: bodyVersion,
      }),
    };
  }

  const clientInfo = meta[META_CLIENT_INFO];
  const clientName =
    clientInfo && typeof clientInfo === "object" && typeof (clientInfo as { name?: unknown }).name === "string"
      ? ((clientInfo as { name: string }).name)
      : null;

  return { id, method, params, clientName };
}

function headerMismatch(id: JsonRpcId, message: string): Rejection {
  return { status: 400, body: errorBody(id, ERROR.headerMismatch, message) };
}

export function isRejection(value: McpRequest | Rejection): value is Rejection {
  return "status" in value;
}

/** True for a body that is a JSON-RPC notification: a method with no id. */
export function isNotification(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const message = body as Record<string, unknown>;
  return typeof message.method === "string" && message.id === undefined;
}
