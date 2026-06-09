// Integration tests: drive the real lsp-proxy.mjs over stdio against mock-server.mjs
// (no real CircleCI binary). Asserts the proxy's filtering, didChange->didOpen
// replay, full-sync rewrite, token injection, and diagnostics scoping.
//
// Uses waitFor() (poll until a condition holds) rather than fixed sleeps so the
// tests don't flake on process-spawn timing. Messages are processed in order, so
// once a later message's effect is observed, earlier ones have already been handled
// — which lets us soundly assert that an earlier out-of-scope message was dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(here, "..", "plugins", "circleci-yaml-lsp", "bin", "lsp-proxy.mjs");
const MOCK = path.join(here, "mock-server.mjs");
const IN = "file:///repo/.circleci/config.yml";   // in scope
const OUT = "file:///repo/docker-compose.yml";     // out of scope
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > ms) return false;
    await sleep(20);
  }
}

function startProxy(env = {}) {
  const proc = spawn(process.execPath, [PROXY, MOCK], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const received = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n"); if (sep === -1) break;
      const m = /content-length:\s*(\d+)/i.exec(buf.toString("ascii", 0, sep));
      if (!m) { buf = buf.subarray(sep + 4); continue; }
      const len = +m[1], s = sep + 4; if (buf.length < s + len) break;
      try { received.push(JSON.parse(buf.subarray(s, s + len).toString("utf8"))); } catch { /* ignore */ }
      buf = buf.subarray(s + len);
    }
  });
  const send = (o) => { const b = Buffer.from(JSON.stringify(o), "utf8"); proc.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); proc.stdin.write(b); };
  return { proc, received, send };
}
const serverSaw = (received) => received.filter((m) => m.method === "$/mockRecv").map((m) => m.params);
const initialize = (send) => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
const initialized = (send) => send({ jsonrpc: "2.0", method: "initialized", params: {} });
const didOpen = (send, uri, text) => send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "yaml", version: 1, text } } });

test("forces full document sync (change:1) in the initialize response", async () => {
  const { proc, received, send } = startProxy();
  initialize(send);
  const ok = await waitFor(() => received.some((m) => m.id === 1 && m.result));
  const reply = received.find((m) => m.id === 1 && m.result);
  proc.kill();
  assert.ok(ok && reply, "received an initialize reply");
  assert.equal(reply.result.capabilities.textDocumentSync.change, 1, "change rewritten 2 -> 1");
  assert.equal(reply.result.capabilities.textDocumentSync.openClose, true);
});

test("drops out-of-scope document syncs; forwards in-scope ones", async () => {
  const { proc, received, send } = startProxy();
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  didOpen(send, OUT, "version: '3'");
  didOpen(send, IN, "version: 2.1");
  const ok = await waitFor(() => serverSaw(received).some((r) => r.uri === IN && r.method === "textDocument/didOpen"));
  const saw = serverSaw(received);
  proc.kill();
  assert.ok(ok, "in-scope didOpen reached the server");
  assert.equal(saw.some((r) => r.uri === OUT), false, "out-of-scope didOpen must be dropped");
});

test("replays didChange as didOpen — server never sees didChange", async () => {
  const { proc, received, send } = startProxy();
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  didOpen(send, IN, "AAA");
  send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: IN, version: 2 }, contentChanges: [{ text: "BBBBB" }] } });
  const ok = await waitFor(() => serverSaw(received).filter((r) => r.uri === IN && r.method === "textDocument/didOpen").length === 2);
  const saw = serverSaw(received).filter((r) => r.uri === IN);
  proc.kill();
  assert.ok(ok, "saw original open + replayed open");
  assert.equal(saw.some((r) => r.method === "textDocument/didChange"), false, "no didChange reaches the server");
  const opens = saw.filter((r) => r.method === "textDocument/didOpen");
  assert.equal(opens[opens.length - 1].textLen, 5, "replayed open carries the new full text");
});

test("incremental didChange is applied to the mirror before replay", async () => {
  const { proc, received, send } = startProxy();
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  didOpen(send, IN, "hello");
  send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: IN, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, text: "bye" }] } });
  const ok = await waitFor(() => serverSaw(received).filter((r) => r.uri === IN && r.method === "textDocument/didOpen").length === 2);
  const opens = serverSaw(received).filter((r) => r.uri === IN && r.method === "textDocument/didOpen");
  proc.kill();
  assert.ok(ok, "saw replayed open");
  assert.equal(opens[opens.length - 1].textLen, 3, "hello(5) -> bye(3) applied to the mirror");
});

test("injects setToken after initialized and swallows the reply", async () => {
  const { proc, received, send } = startProxy({ CIRCLECI_YAML_LSP_TOKEN: "secret-token" });
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  const ok = await waitFor(() => serverSaw(received).some((r) => r.command === "setToken"));
  const tok = serverSaw(received).find((r) => r.command === "setToken");
  const leaked = received.some((m) => typeof m.id === "string" && m.id.startsWith("__cci_proxy__"));
  proc.kill();
  assert.ok(ok && tok, "server received setToken");
  assert.deepEqual(tok.args, ["secret-token"]);
  assert.equal(leaked, false, "injected command's reply must not reach the client");
});

test("no token injection when CIRCLECI_YAML_LSP_TOKEN is unset", async () => {
  const { proc, received, send } = startProxy();
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  // Wait until the server has seen `initialized`; setToken (if any) is injected
  // immediately after, so its absence by then means no injection.
  await waitFor(() => serverSaw(received).some((r) => r.method === "initialized"));
  await sleep(50);
  const tok = serverSaw(received).find((r) => r.command === "setToken");
  proc.kill();
  assert.equal(tok, undefined);
});

test("filters server->client diagnostics by scope", async () => {
  const { proc, received, send } = startProxy();
  initialize(send); await waitFor(() => received.some((m) => m.id === 1 && m.result));
  initialized(send);
  send({ jsonrpc: "2.0", method: "$/emitDiag", params: { uri: OUT } });
  send({ jsonrpc: "2.0", method: "$/emitDiag", params: { uri: IN } });
  const ok = await waitFor(() => received.some((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === IN));
  const diags = received.filter((m) => m.method === "textDocument/publishDiagnostics");
  proc.kill();
  assert.ok(ok, "in-scope diagnostics forwarded");
  assert.equal(diags.some((d) => d.params.uri === OUT), false, "out-of-scope diagnostics dropped");
});
