#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { validateDinkuskitCanaryReport } from "./validate-dinkuskit-canary-report.mjs";

const BOT_LOGIN_PATTERN = /^[A-Za-z0-9-]+\[bot\]$/;
const MANAGED_LABEL_PATTERN = /^(?:clawsweeper:|rating: |status: |proof: |mantis: )/i;

function readRegularJson(filePath, label) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(filePath)));
}

function reportFrontmatter(reportPath) {
  const markdown = readFileSync(reportPath, "utf8");
  const end = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || end < 0) throw new Error("report frontmatter is missing");
  const fields = new Map();
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (fields.has(key)) throw new Error(`report has duplicate frontmatter field: ${key}`);
    fields.set(key, line.slice(separator + 1).trim());
  }
  return fields;
}

function normalizedLabels(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const normalized = value.map((entry) => entry.trim().toLowerCase()).sort();
  if (normalized.some((entry) => !entry)) throw new Error(`${label} contains an empty label`);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate labels`);
  }
  return normalized;
}

function validateApplyReport(value, itemNumber) {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("apply report must contain zero or one result");
  }
  if (value.length === 0) return;
  const result = value[0];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("apply report result is invalid");
  }
  if (result.number !== itemNumber) throw new Error("apply report item does not match");
  if (result.action === "review_comment_synced") {
    if (typeof result.reason !== "string" || !result.reason.trim()) {
      throw new Error("comment-sync result lacks a reason");
    }
    return;
  }
  if (result.action === "kept_open" && result.reason === "synced ClawSweeper labels") return;
  throw new Error(`apply report did not prove native publication: ${String(result.action)}`);
}

export function validateDinkuskitCanaryPublication(options) {
  const itemNumber = Number(options.itemNumber);
  const appBotLogin = String(options.appBotLogin ?? "")
    .trim()
    .toLowerCase();
  if (!BOT_LOGIN_PATTERN.test(appBotLogin)) throw new Error("App bot login is invalid");

  const reportValidation = validateDinkuskitCanaryReport(options);
  const fields = reportFrontmatter(options.reportPath);
  validateApplyReport(readRegularJson(options.applyReportPath, "apply report"), itemNumber);

  const comments = readRegularJson(options.commentsPath, "comments");
  if (!Array.isArray(comments)) throw new Error("comments must be an array");
  const marker = `<!-- clawsweeper-review item=${itemNumber} -->`;
  const matching = comments.filter((comment) => {
    const author = String(comment?.user?.login ?? "").toLowerCase();
    const body = typeof comment?.body === "string" ? comment.body : "";
    return author === appBotLogin && body.includes(marker);
  });
  if (matching.length !== 1) throw new Error("expected exactly one App-authored native review");

  const comment = matching[0];
  const commentId = String(comment.id ?? "");
  const commentUrl = String(comment.html_url ?? "");
  const commentBody = String(comment.body ?? "");
  if (fields.get("review_comment_id") !== commentId) {
    throw new Error("published comment id does not match the state record");
  }
  if (!commentUrl || fields.get("review_comment_url") !== commentUrl) {
    throw new Error("published comment URL does not match the state record");
  }
  const commentHash = createHash("sha256").update(commentBody.trim()).digest("hex");
  if (fields.get("review_comment_sha256") !== commentHash) {
    throw new Error("published comment body does not match the state record hash");
  }

  let recordedLabels;
  try {
    recordedLabels = JSON.parse(fields.get("labels") ?? "");
  } catch {
    throw new Error("state record labels are not valid JSON");
  }
  const liveLabels = readRegularJson(options.labelsPath, "live labels");
  const normalizedRecorded = normalizedLabels(recordedLabels, "state record labels");
  const normalizedLive = normalizedLabels(liveLabels, "live labels");
  if (JSON.stringify(normalizedRecorded) !== JSON.stringify(normalizedLive)) {
    throw new Error("live labels do not exactly match the native state record");
  }
  if (!liveLabels.some((label) => MANAGED_LABEL_PATTERN.test(label))) {
    throw new Error("native publication did not produce a managed ClawSweeper label");
  }

  return {
    ...reportValidation,
    comment_id: Number(commentId),
    comment_sha256: commentHash,
    label_count: liveLabels.length,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  const result = validateDinkuskitCanaryPublication({
    reportPath: args.report,
    applyReportPath: args["apply-report"],
    commentsPath: args.comments,
    labelsPath: args.labels,
    appBotLogin: args["app-bot-login"],
    repository: args.repository,
    itemNumber: args["item-number"],
    baseSha: args["base-sha"],
    headSha: args["head-sha"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
