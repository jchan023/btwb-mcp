// Offline tests for the request plumbing in src/btwb-client.js. BTWB has no
// sandbox, so `fetch` is replaced with a small fake of the parts of the site the
// client touches (sign-in, whiteboard, write endpoints). These cover cookie
// handling, retries and timeouts - not BTWB's real markup, which still has to be
// verified by hand against a logged-in session.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshClient, installFakeBtwb, loginPosts, reply, useFakeEnv, writes } from "./support/fake-btwb.js";

useFakeEnv();

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
