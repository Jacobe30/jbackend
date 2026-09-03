// Post-deploy smoke test: node scripts/verify.mjs [worker-url]
const base = process.argv[2] || "https://gosuksa-edge.bcare.workers.dev";
const origin = "https://gosuksa-tmin.lovable.app";

async function check(label, run) {
  try {
    const ok = await run();
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    return ok;
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    return false;
  }
}

let allOk = true;

allOk &= await check("GET /breinit returns 200", async () => {
  const res = await fetch(`${base}/breinit`, { headers: { Origin: origin } });
  console.log("      status:", res.status, "body:", (await res.text()).slice(0, 120));
  return res.status === 200;
});

allOk &= await check(`CORS allows ${origin}`, async () => {
  const res = await fetch(`${base}/breinit`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allow = res.headers.get("access-control-allow-origin");
  console.log("      access-control-allow-origin:", allow);
  return allow === origin;
});

allOk &= await check("CORS blocks an unlisted origin", async () => {
  const res = await fetch(`${base}/breinit`, {
    method: "OPTIONS",
    headers: { Origin: "https://not-allowed.example", "Access-Control-Request-Method": "GET" },
  });
  return res.headers.get("access-control-allow-origin") === null;
});

allOk &= await check("Socket.IO polling handshake", async () => {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: origin },
  });
  const body = await res.text();
  console.log("      status:", res.status, "upgrades:", /websocket/.test(body));
  return res.status === 200 && /websocket/.test(body);
});

process.exit(allOk ? 0 : 1);
