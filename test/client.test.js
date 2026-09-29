// Offline tests for the request plumbing in src/btwb-client.js. BTWB has no
// sandbox, so `fetch` is replaced with a small fake of the parts of the site the
// client touches (sign-in, whiteboard, write endpoints). These cover cookie
// handling, retries and timeouts - not BTWB's real markup, which still has to be
// verified by hand against a logged-in session.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
const freshClient = () => import(`../src/btwb-client.js?fresh=${++importCount}`);

function reply(body = "", { status = 200, cookies = [], headers = {} } = {}) {
  const h = new Headers({ "content-type": "text/html", ...headers });
  for (const cookie of cookies) h.append("set-cookie", cookie);
  return new Response(body, { status, headers: h });
}

// Fake BTWB. `handler(req, state)` may return a Response (or a promise of one)
// to override any route; otherwise the defaults below apply. Only the first
// whiteboard page load rotates the session cookie, so a later change to the
// cookie the client sends can only have come from a write response.
function installFakeBtwb(handler) {
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

const loginPosts = (calls) => calls.filter((c) => c.pathname === "/session");
const writes = (calls) =>
  calls.filter((c) => (c.method === "POST" || c.method === "DELETE") && c.pathname !== "/session");

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

describe("writes", () => {
  it("carry a rotated session cookie into the next request", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    await client.deleteWorkoutSession(123);
    await client.deleteWeighIn(9);

    const [first, second] = writes(calls);
    assert.equal(first.pathname, "/workout_sessions/123");
    assert.match(second.headers.Cookie, /_btwb_session_id=after-write-1/);
  });

  it("send the CSRF token and no body on DELETE", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    await client.deleteWeighIn(9);

    const [del] = writes(calls);
    assert.equal(del.method, "DELETE");
    assert.equal(del.pathname, "/weigh_ins/9");
    assert.equal(del.headers["X-CSRF-Token"], "csrf1");
    assert.equal(del.headers["Content-Type"], undefined);
    assert.equal(del.body, undefined);
  });

  it("post logWorkout as a private form", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    const result = await client.logWorkout({
      movementId: 13,
      movementName: "Thruster",
      reps: 10,
      weight: 65,
      performedDate: "2026-09-29",
    });

    const [post] = writes(calls);
    assert.equal(post.pathname, "/workouts/logger");
    assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(post.body).get("workout_session[privacy]"), "onlyme");
    assert.equal(result.privacy, "onlyme");
    assert.equal(result.redirectedTo, "/workout_sessions/1");
  });

  it("are not retried when they fail", async () => {
    const { calls } = installFakeBtwb((req) =>
      req.pathname === "/workouts/logger" ? reply("boom", { status: 422 }) : undefined
    );
    const client = await freshClient();

    await assert.rejects(
      client.logWorkout({
        movementId: 13,
        movementName: "Thruster",
        reps: 1,
        weight: 1,
        performedDate: "2026-09-29",
      }),
      /log_workout failed: HTTP 422\. boom/
    );
    assert.equal(calls.filter((c) => c.pathname === "/workouts/logger").length, 1);
    assert.equal(loginPosts(calls).length, 1, "only the initial login, no re-login for a write");
  });
});

describe("reads", () => {
  it("log in again once when BTWB serves the signed-out page (JSON endpoint)", async () => {
    let served = 0;
    const { calls } = installFakeBtwb((req) => {
      if (req.pathname === "/exercises/autocomplete_name.json") {
        return served++ === 0 ? reply("<html>Sign in</html>") : reply('[{"id":13,"name":"Thruster"}]');
      }
    });
    const client = await freshClient();

    const found = await client.searchMovement("thruster");

    assert.deepEqual(found, [{ id: 13, name: "Thruster" }]);
    assert.equal(loginPosts(calls).length, 2, "initial login + one re-login");
  });

  it("log in again once when a workout session page is signed out", async () => {
    let served = 0;
    const { calls } = installFakeBtwb((req) => {
      if (req.pathname === "/workout_sessions/555") {
        return served++ === 0
          ? reply("<html>Sign in</html>")
          : reply('<meta name="csrf-token" content="c"><p>Sets <br>185 x1</p>');
      }
    });
    const client = await freshClient();

    const session = await client.getWorkoutSession(555);

    assert.deepEqual(session.sets, ["185 x1"]);
    assert.equal(loginPosts(calls).length, 2, "initial login + one re-login");
  });

  it("return an empty chart when the history endpoint answers with an empty body", async () => {
    installFakeBtwb((req) =>
      req.pathname.endsWith("/vmax") ? reply("", { headers: { "content-type": "application/json" } }) : undefined
    );
    const client = await freshClient();

    const history = await client.getMovementHistory({ movementId: 13, movementSlug: "thruster" });

    assert.deepEqual(history, { series: [], units: null });
  });
});

describe("timeouts", () => {
  it("fail a hung request with a clear error instead of hanging", async () => {
    process.env.BTWB_REQUEST_TIMEOUT_MS = "50";
    // AbortSignal.timeout's timer is unref'd, so in a test with nothing else
    // pending the process would exit before it fires (the real server stays
    // alive on its stdio transport). Hold a ref'd timer until the abort.
    installFakeBtwb(
      (req) =>
        req.pathname === "/whiteboard" &&
        new Promise((_, reject) => {
          const keepAlive = setInterval(() => {}, 1000);
          req.signal.addEventListener("abort", () => {
            clearInterval(keepAlive);
            reject(req.signal.reason);
          });
        })
    );
    const client = await freshClient();

    await assert.rejects(client.getMemberId(), /BTWB request to \/whiteboard timed out/);
  });
});

describe("credentials", () => {
  it("explain how to set up a session when there is no cookie or login", async () => {
    delete process.env.BTWB_EMAIL;
    delete process.env.BTWB_PASSWORD;
    installFakeBtwb();
    const client = await freshClient();

    await assert.rejects(client.getMemberId(), /No BTWB session cookie found/);
  });
});
