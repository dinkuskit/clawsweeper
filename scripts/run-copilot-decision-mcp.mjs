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
import { pathToFileURL } from "node:url";

const MAX_MESSAGE_BYTES = 1_500_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SUBMISSION_ATTEMPTS = 4;
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
if (argv.length !== 3) terminate("expected the exact schema, response, and validator paths");
const [configuredSchemaPath, responsePath, configuredValidatorPath] = argv;
if (
  !isAbsolute(configuredSchemaPath) ||
  !isAbsolute(responsePath) ||
  !isAbsolute(configuredValidatorPath)
) {
  terminate("schema, response, and validator paths must be absolute");
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
let validatorPath;
try {
  validatorPath = realpathSync(configuredValidatorPath);
} catch {
  terminate("the native decision validator did not resolve");
}
if (basename(validatorPath) !== "clawsweeper.js" || basename(dirname(validatorPath)) !== "dist") {
  terminate("the admitted native decision validator was unavailable");
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

let parseDecision;
try {
  ({ parseDecision } = await import(pathToFileURL(validatorPath).href));
} catch {
  terminate("the native decision validator could not be loaded");
}
if (typeof parseDecision !== "function") {
  terminate("the native decision validator did not expose parseDecision");
}

let responseSubmitted = false;
let submissionAttempts = 0;
function boundedValidationMessage(error) {
  const message = error instanceof Error ? error.message : "native decision validation failed";
  return [...message]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("")
    .slice(0, 500);
}

function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const { id, method, params } = message;
  if (method === "initialize" && id !== undefined) {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ClawSweeper", version: "1.0.0" },
      instructions:
        "After completing the review, call submit_review with the complete native ClawSweeper decision. If validation rejects it, correct the named invariant and retry until accepted.",
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
            "Submit the complete native ClawSweeper review. If native validation rejects an invariant, correct it and retry; only the first accepted submission is recorded.",
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
    submissionAttempts += 1;
    if (submissionAttempts > MAX_SUBMISSION_ATTEMPTS) {
      respondError(id, -32600, "the bounded native review submission budget was exhausted");
      return;
    }
    const decision = params?.arguments;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      respondError(id, -32602, "submit_review requires one decision object");
      return;
    }
    let validatedDecision;
    try {
      validatedDecision = parseDecision(decision);
    } catch (error) {
      respondError(
        id,
        -32602,
        `native validation rejected the submission: ${boundedValidationMessage(error)}`,
      );
      return;
    }
    const payload = `${JSON.stringify(validatedDecision)}\n`;
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
