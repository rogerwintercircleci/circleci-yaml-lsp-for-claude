// Pure, side-effect-free helpers for lsp-proxy.mjs, separated so they can be
// unit-tested without spawning a server. No imports, no process/IO access.

// Default "in scope" = a CircleCI config file directly inside a .circleci/ directory:
// config.yml/.yaml or a <prefix>_config.yml (e.g. continue_config.yml, setup_config.yml).
// Excludes other YAML kept under .circleci/ (test-suites.yml, eslint.config.yml,
// db-config.yml, config-backup.yml) and files in subdirectories.
export const DEFAULT_SCOPE = /(^|\/)\.circleci\/([^/]*_)?config\.ya?ml$/i;

// Build an inScope(uri) predicate. `pattern` (optional) is a regex source string
// (matched case-insensitively) overriding the default; an invalid pattern falls
// back to the default and reports via onError(message) if provided.
export function makeInScope(pattern, onError) {
  let re = DEFAULT_SCOPE;
  if (pattern) {
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      if (onError) onError(`invalid scope pattern, using default: ${e.message}`);
    }
  }
  return (uri) => typeof uri === "string" && re.test(uri);
}

// LSP position (line, UTF-16 character) -> offset into `text`. JS strings are
// UTF-16, so character maps to a string index directly for the common (BMP) case.
export function posToOffset(text, pos) {
  if (!pos) return text.length;
  let i = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) return text.length;
    i = nl + 1;
  }
  return Math.min(i + (pos.character || 0), text.length);
}

// Apply LSP content changes (full-replace when range is absent, otherwise
// incremental) to `text`, returning the new full text.
export function applyEdits(text, changes) {
  for (const c of changes || []) {
    if (!c) continue;
    if (c.range == null) {
      if (typeof c.text === "string") text = c.text;
      continue;
    }
    const s = posToOffset(text, c.range.start);
    const e = posToOffset(text, c.range.end);
    text = text.slice(0, s) + (c.text || "") + text.slice(e);
  }
  return text;
}

// Frame an already-serialized JSON-RPC body (Buffer) with LSP Content-Length
// headers. Length is the byte length of the body (correct for multibyte UTF-8).
export function frame(body) {
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

// Streaming reader for Content-Length-framed LSP messages. Returns a function you
// feed chunks (Buffer); it invokes onMessage(parsedOrNull, rawBodyBuffer) for each
// complete message, tolerating partial reads, multiple messages per chunk, and
// (by resyncing) malformed headers.
export function makeReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.toString("ascii", 0, sep));
      if (!m) { buf = buf.subarray(sep + 4); continue; } // malformed; resync
      const len = parseInt(m[1], 10);
      const start = sep + 4;
      if (buf.length < start + len) return; // body not fully arrived yet
      const body = buf.subarray(start, start + len);
      buf = buf.subarray(start + len);
      let msg = null;
      try { msg = JSON.parse(body.toString("utf8")); } catch { /* pass raw */ }
      // A bug or malformed message must not tear down the whole stream/proxy.
      try { onMessage(msg, body); }
      catch (e) { try { process.stderr.write(`[lsp-proxy] message handler error: ${e && e.message}\n`); } catch { /* ignore */ } }
    }
  };
}
