import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach } from "node:test";

// The client shells out to macOS `security` to read AND overwrite the real
// session cookie in Keychain. Put a stub that always fails first on PATH so a
// test run can never touch a developer's actual Keychain.
const stubBin = mkdtempSync(join(tmpdir(), "btwb-test-bin-"));
writeFileSync(join(stubBin, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(join(stubBin, "security"), 0o755);
process.env.PATH = `${stubBin}${delimiter}${process.env.PATH}`;

const realFetch = globalThis.fetch;
const ENV_KEYS = ["BTWB_EMAIL", "BTWB_PASSWORD", "BTWB_REQUEST_TIMEOUT_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let importCount = 0;

// The client keeps its cookie and member ID in module state, so every test
// imports a fresh copy.
export const freshClient = () => import(`../../src/btwb-client.js?fresh=${++importCount}`);

export function reply(body = "", { status = 200, cookies = [], headers = {} } = {}) {
  const h = new Headers({ "content-type": "text/html", ...headers });
  for (const cookie of cookies) h.append("set-cookie", cookie);
  return new Response(body, { status, headers: h });
}

// Fake BTWB. `handler(req, state)` may return a Response (or a promise of one)
// to override any route; otherwise the defaults below apply. Only the first
// whiteboard page load rotates the session cookie, so a later change to the
// cookie the client sends can only have come from a write response.
export function installFakeBtwb(handler) {
  const calls = [];
  const state = { loggedIn: false, whiteboardHits: 0, writes: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const req = {
      pathname: new URL(url).pathname,
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? String(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(req);

    const custom = handler?.(req, state);
    if (custom) return custom;

    if (req.pathname === "/signin") {
      return reply('<input name="authenticity_token" value="tok">', {
        cookies: ["_btwb_session_id=pre; Path=/"],
      });
    }
    if (req.pathname === "/session" && req.method === "POST") {
      state.loggedIn = true;
      return reply("", {
        status: 302,
        cookies: ["_btwb_session_id=login; Path=/", "remember_me_token=rm; Path=/"],
      });
    }
    if (req.pathname === "/whiteboard") {
      return reply('<meta name="csrf-token" content="csrf1"><a href="/analyze/members/42">me</a>', {
        cookies: state.whiteboardHits++ === 0 ? ["_btwb_session_id=rotated; Path=/"] : [],
      });
    }
    if (req.method === "POST" || req.method === "DELETE") {
      return reply("", {
        status: 302,
        headers: { location: "/workout_sessions/1" },
        cookies: [`_btwb_session_id=after-write-${++state.writes}; Path=/`],
      });
    }
    return reply("", { status: 404 });
  };
  return { calls, state };
}

export const loginPosts = (calls) => calls.filter((c) => c.pathname === "/session");
export const writes = (calls) =>
  calls.filter((c) => (c.method === "POST" || c.method === "DELETE") && c.pathname !== "/session");

export function useFakeEnv() {
  beforeEach(() => {
    process.env.BTWB_EMAIL = "test@example.com";
    process.env.BTWB_PASSWORD = "not-a-real-password";
    delete process.env.BTWB_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
}
