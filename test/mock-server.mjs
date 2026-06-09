#!/usr/bin/env node
//
// mock-server.mjs — a tiny fake LSP server for integration-testing lsp-proxy.mjs
// without the real CircleCI binary. It:
//   - replies to `initialize` advertising INCREMENTAL sync (change: 2), like the
//     real server, so we can verify the proxy rewrites it to FULL (change: 1);
//   - echoes every message it receives back to the client as a `$/mockRecv`
//     notification, so the test can observe what got past the proxy's filtering;
//   - on a custom `$/emitDiag` notification, emits a publishDiagnostics for the
//     given URI (to exercise the proxy's server->client diagnostics scope filter);
//   - replies to executeCommand / shutdown.
// Independent framing (does not import the proxy lib) so it is an honest oracle.

let buf = Buffer.alloc(0);
function send(obj) {
  const b = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`);
  process.stdout.write(b);
}

process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.toString("ascii", 0, sep));
    if (!m) { buf = buf.subarray(sep + 4); continue; }
    const len = +m[1], start = sep + 4;
    if (buf.length < start + len) return;
    let msg = null;
    try { msg = JSON.parse(buf.subarray(start, start + len).toString("utf8")); } catch { /* ignore */ }
    buf = buf.subarray(start + len);
    if (msg) handle(msg);
  }
});

function handle(msg) {
  // Observability: report exactly what reached the server.
  send({ jsonrpc: "2.0", method: "$/mockRecv", params: {
    method: msg.method,
    id: msg.id,
    uri: msg.params?.textDocument?.uri,
    textLen: msg.params?.textDocument?.text?.length,
    command: msg.params?.command,
    args: msg.params?.arguments,
  } });

  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {
        textDocumentSync: { openClose: true, change: 2 }, // INCREMENTAL on purpose
        completionProvider: {}, definitionProvider: true,
      } } });
      break;
    case "$/emitDiag":
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
        uri: msg.params.uri,
        diagnostics: msg.params.diagnostics || [{ message: "mock diagnostic", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      } });
      break;
    case "workspace/executeCommand":
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
      break;
    case "shutdown":
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
      break;
    case "exit":
      process.exit(0);
  }
}
