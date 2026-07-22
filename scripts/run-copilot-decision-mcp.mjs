#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

const MAX_MESSAGE_BYTES = 1_500_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const TOOL_NAME = "submit_review";

function terminate(message) {
  process.stderr.write(`ClawSweeper decision MCP: ${message}\n`);
  process.exit(1);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const argv = process.argv.slice(2);
if (argv.length !== 2) terminate("expected the exact schema and response paths");
const [configuredSchemaPath, responsePath] = argv;
if (!isAbsolute(configuredSchemaPath) || !isAbsolute(responsePath)) {
  terminate("schema and response paths must be absolute");
}

let schemaPath;
try {
  schemaPath = realpathSync(configuredSchemaPath);
} catch {
  terminate("the decision schema did not resolve");
}
if (basename(schemaPath) !== "clawsweeper-decision.schema.json" || !statSync(schemaPath).isFile()) {
  terminate("the admitted native decision schema was unavailable");
}
if (basename(responsePath) !== ".clawsweeper-copilot-response.json") {
  terminate("the response path did not match the bounded contract");
}
try {
  realpathSync(dirname(responsePath));
} catch {
  terminate("the response directory did not resolve");
}

let decisionSchema;
try {
  decisionSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
} catch {
  terminate("the native decision schema was invalid");
}
if (
  !decisionSchema ||
  typeof decisionSchema !== "object" ||
  Array.isArray(decisionSchema) ||
  decisionSchema.type !== "object"
) {
  terminate("the native decision schema was not an object schema");
}

let responseSubmitted = false;
function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const { id, method, params } = message;
  if (method === "initialize" && id !== undefined) {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ClawSweeper", version: "1.0.0" },
      instructions:
        "After completing the review, call submit_review exactly once. Its arguments are the complete native ClawSweeper decision.",
    });
    return;
  }
  if (method === "ping" && id !== undefined) {
    respond(id, {});
    return;
  }
  if (method === "tools/list" && id !== undefined) {
    respond(id, {
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Submit the complete native ClawSweeper review. Call exactly once after reviewing; this is the only accepted completion mechanism.",
          inputSchema: decisionSchema,
        },
      ],
    });
    return;
  }
  if (method === "tools/call" && id !== undefined) {
    if (params?.name !== TOOL_NAME) {
      respondError(id, -32602, "only submit_review is admitted");
      return;
    }
    if (responseSubmitted) {
      respondError(id, -32600, "the native review was already submitted");
      return;
    }
    const decision = params?.arguments;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      respondError(id, -32602, "submit_review requires one decision object");
      return;
    }
    const payload = `${JSON.stringify(decision)}\n`;
    if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
      respondError(id, -32602, "the native review exceeded its bounded size");
      return;
    }
    let responseFd;
    try {
      responseFd = openSync(
        responsePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(responseFd, payload, "utf8");
    } catch {
      respondError(id, -32603, "the bounded native review could not be recorded");
      return;
    } finally {
      if (responseFd !== undefined) closeSync(responseFd);
    }
    responseSubmitted = true;
    respond(id, {
      content: [{ type: "text", text: "Native ClawSweeper review accepted." }],
    });
    return;
  }
  if (id !== undefined) respondError(id, -32601, "method not found");
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer) > MAX_MESSAGE_BYTES) {
    terminate("an MCP request exceeded the bounded message size");
  }
  let newline = inputBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        respondError(null, -32700, "parse error");
      }
    }
    newline = inputBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (inputBuffer.trim()) {
    try {
      handleMessage(JSON.parse(inputBuffer));
    } catch {
      respondError(null, -32700, "parse error");
    }
  }
});
