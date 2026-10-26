// Influence Hub — self-hosted backend.
// Zero npm dependencies on purpose: only Node's built-in http/fs/crypto.
// Replaces the three Claude Artifact capabilities the original page used:
//   db      -> JSON-file-backed REST API below (/api/list, /api/get, /api/set, ...)
//   user    -> shared-password auth; "who is acting" is a simple name picker (ROLE_ASSIGNEES)
//   assets  -> /api/upload (base64 JSON body) + /uploads/:id static serving
//
// Storage model mirrors the original `db.collection(path).doc(id)` semantics:
// one flat JSON file holds { [collectionPath]: { [docId]: {data, version, updatedAt} } }.
// Writes are synchronous + atomic (write tmp file, rename) — fine for a 2-person tool.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const UPLOADS_INDEX_FILE = path.join(DATA_DIR, "uploads-index.json");
const PORT = process.env.PORT || 8080;

// Shared password for the whole team. Set APP_PASSWORD in the environment in
// production — this default is only for local smoke-testing in this session.
const APP_PASSWORD = process.env.APP_PASSWORD || "changeme";
// Signing secret for the session cookie. Set SESSION_SECRET in production.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- tiny JSON-file store ----------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJsonAtomic(file, obj) {
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

let store = loadJson(STORE_FILE, {});
let uploadsIndex = loadJson(UPLOADS_INDEX_FILE, {});

function persistStore() { saveJsonAtomic(STORE_FILE, store); }
function persistUploads() { saveJsonAtomic(UPLOADS_INDEX_FILE, uploadsIndex); }

function col(path_) {
  if (!store[path_]) store[path_] = {};
  return store[path_];
}

function genId() {
  return crypto.randomBytes(9).toString("base64url");
}

// ---------- session cookie (HMAC-signed, no external deps) ----------
function sign(value) {
  const h = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
  return value + "." + h;
}
function verify(signed) {
  if (!signed || typeof signed !== "string") return null;
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  if (expected.length !== signed.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signed));
  return ok ? value : null;
}
function makeSessionCookie() {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  return sign("ok:" + expires);
}
function isSessionValid(cookieVal) {
  const raw = verify(cookieVal);
  if (!raw) return false;
  const m = /^ok:(\d+)$/.exec(raw);
  if (!m) return false;
  return Number(m[1]) > Date.now();
}
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(function (part) {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// ---------- request helpers ----------
function readBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    let data = [];
    let size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("payload_too_large")); req.destroy(); return; }
      data.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(data)); });
    req.on("error", reject);
  });
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text, contentType) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, { "Content-Type": contentType || "text/plain; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

// ---------- document helpers ----------
function docSnapshot(id, row) {
  return { id: id, version: row.version, updatedAt: row.updatedAt, data: row.data };
}
function listCollection(path_, opts) {
  const c = col(path_);
  let rows = Object.keys(c).map(function (id) { return docSnapshot(id, c[id]); });
  if (opts.orderBy) {
    const field = opts.orderBy, dir = opts.dir === "desc" ? -1 : 1;
    rows.sort(function (a, b) {
      const av = a.data ? a.data[field] : undefined;
      const bv = b.data ? b.data[field] : undefined;
      if (av == null && bv == null) return 0;
      if (av == null) return -1 * dir;
      if (bv == null) return 1 * dir;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

// ---------- API routing ----------
const API_LOGIN_PATHS = ["/api/login"];

function handleApi(req, res, parsed, authed) {
  const pathname = parsed.pathname;
  if (!authed && API_LOGIN_PATHS.indexOf(pathname) === -1) {
    sendJson(res, 401, { error: "not_authenticated" });
    return;
  }

  if (pathname === "/api/login" && req.method === "POST") {
    readBody(req, 1024).then(function (buf) {
      let body = {};
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) {}
      if (body.password === APP_PASSWORD) {
        const cookie = makeSessionCookie();
        res.setHeader("Set-Cookie", "ih_session=" + cookie + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_MAX_AGE_MS / 1000));
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 401, { ok: false, error: "wrong_password" });
      }
    }).catch(function () { sendJson(res, 400, { error: "bad_request" }); });
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", "ih_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/list" && req.method === "GET") {
    const q = parsed.query;
    const rows = listCollection(q.collection || "", { orderBy: q.orderBy, dir: q.dir, limit: q.limit ? parseInt(q.limit, 10) : null });
    sendJson(res, 200, { docs: rows });
    return;
  }

  if (pathname === "/api/get" && req.method === "GET") {
    const q = parsed.query;
    const c = col(q.collection || "");
    const row = c[q.id];
    sendJson(res, 200, { doc: row ? docSnapshot(q.id, row) : null });
    return;
  }

  if ((pathname === "/api/set" || pathname === "/api/add" || pathname === "/api/update" || pathname === "/api/delete") && req.method === "POST") {
    readBody(req, 5 * 1024 * 1024).then(function (buf) {
      let body = {};
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) { sendJson(res, 400, { error: "bad_json" }); return; }
      try {
        const result = applyWrite(pathname, body);
        persistStore();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 400, { error: e.message || "write_failed" });
      }
    }).catch(function () { sendJson(res, 400, { error: "bad_request" }); });
    return;
  }

  if (pathname === "/api/batch" && req.method === "POST") {
    readBody(req, 5 * 1024 * 1024).then(function (buf) {
      let body = {};
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) { sendJson(res, 400, { error: "bad_json" }); return; }
      try {
        const results = (body.writes || []).map(function (w) {
          const op = w.op === "set" ? "/api/set" : w.op === "update" ? "/api/update" : "/api/delete";
          return applyWrite(op, w);
        });
        persistStore();
        sendJson(res, 200, { results: results });
      } catch (e) {
        sendJson(res, 400, { error: e.message || "batch_failed" });
      }
    }).catch(function () { sendJson(res, 400, { error: "bad_request" }); });
    return;
  }

  if (pathname === "/api/upload" && req.method === "POST") {
    readBody(req, 25 * 1024 * 1024).then(function (buf) {
      let body = {};
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) { sendJson(res, 400, { error: "bad_json" }); return; }
      if (!body.dataBase64) { sendJson(res, 400, { error: "missing_data" }); return; }
      const id = genId();
      const safeName = (body.filename || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);
      const diskName = id + "_" + safeName;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, diskName), Buffer.from(body.dataBase64, "base64"));
      } catch (e) { sendJson(res, 400, { error: "write_failed" }); return; }
      uploadsIndex[id] = { filename: body.filename || "file", mime: body.mime || "application/octet-stream", diskName: diskName, createdAt: new Date().toISOString() };
      persistUploads();
      sendJson(res, 200, { id: id, url: "/uploads/" + id, filename: uploadsIndex[id].filename });
    }).catch(function () { sendJson(res, 400, { error: "bad_request" }); });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

// Shallow-merge "update" (matches Firestore-style .update(): top-level keys
// replaced wholesale, nested objects are NOT deep-merged — same behaviour the
// original artifact `db` capability had, which the frontend's business logic
// already assumes).
function applyWrite(kind, body) {
  const collection = body.collection;
  if (!collection) throw new Error("missing_collection");
  const c = col(collection);
  const now = new Date().toISOString();

  if (kind === "/api/delete") {
    if (!body.id) throw new Error("missing_id");
    delete c[body.id];
    return { ok: true };
  }

  if (kind === "/api/add") {
    const id = genId();
    c[id] = { data: body.data || {}, version: 1, updatedAt: now };
    return { id: id, version: 1 };
  }

  if (kind === "/api/set") {
    const id = body.id || genId();
    const prevVersion = c[id] ? c[id].version : 0;
    c[id] = { data: body.data || {}, version: prevVersion + 1, updatedAt: now };
    return { id: id, version: c[id].version };
  }

  if (kind === "/api/update") {
    if (!body.id) throw new Error("missing_id");
    const existing = c[body.id];
    if (!existing) throw new Error("not_found");
    const merged = Object.assign({}, existing.data, body.data || {});
    // honour {"__delete__": true} sentinel on top-level fields, same as the
    // artifact db capability, so no business logic needs to special-case us.
    Object.keys(merged).forEach(function (k) {
      if (merged[k] && typeof merged[k] === "object" && merged[k].__delete__ === true) delete merged[k];
    });
    c[body.id] = { data: merged, version: existing.version + 1, updatedAt: now };
    return { id: body.id, version: c[body.id].version };
  }

  throw new Error("unknown_op");
}

// ---------- static file serving ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function serveFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) { sendText(res, 404, "Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  });
}

function serveUpload(res, id) {
  const entry = uploadsIndex[id];
  if (!entry) { sendText(res, 404, "Not found"); return; }
  const filePath = path.join(UPLOADS_DIR, entry.diskName);
  fs.readFile(filePath, function (err, data) {
    if (err) { sendText(res, 404, "Not found"); return; }
    res.writeHead(200, { "Content-Type": entry.mime, "Content-Disposition": "inline; filename=\"" + entry.filename.replace(/"/g, "") + "\"", "Content-Length": data.length });
    res.end(data);
  });
}

// ---------- main request handler ----------
const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const cookies = parseCookies(req.headers.cookie);
  const authed = isSessionValid(cookies.ih_session);

  if (pathname.indexOf("/api/") === 0) { handleApi(req, res, parsed, authed); return; }

  if (pathname.indexOf("/uploads/") === 0) {
    if (!authed) { sendText(res, 401, "Not authenticated"); return; }
    serveUpload(res, pathname.slice("/uploads/".length));
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    serveFile(res, path.join(PUBLIC_DIR, authed ? "app.html" : "login.html"));
    return;
  }

  if (pathname === "/healthz") { sendText(res, 200, "ok"); return; }

  // any other static asset under /public (favicon etc.)
  const safe = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  serveFile(res, path.join(PUBLIC_DIR, safe));
});

server.listen(PORT, function () {
  console.log("Influence Hub server listening on :" + PORT);
  console.log("Data dir: " + DATA_DIR);
  if (!process.env.APP_PASSWORD) console.log("WARNING: APP_PASSWORD not set — using insecure default. Set it before deploying.");
});
