// Offline tests for the workout-builder and scheduling tools. Like client.test.js
// these run against a fake fetch, so they pin down request plumbing (cookies,
// tokens, redirects) and input validation - not BTWB's real markup, which was
// verified by hand against a logged-in account.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshClient, installFakeBtwb, reply, useFakeEnv, writes } from "./support/fake-btwb.js";

useFakeEnv();

const BENCH = { movementName: "Bench Press", movementId: 12 };
const PULLUP = { movementName: "Pull-up", movementId: 7, reps: 5 };

const found = (name, id = 9385) => reply(`<h2>Workout Found: ${name} (id: ${id})</h2>`);
const newForm = (token = "form-token") =>
  reply(`<form id="new-workout-form"><input name="authenticity_token" value="${token}"></form>`);

const planPage =
  '<meta name="csrf-token" content="plan-csrf">' +
  '<input type="text" value="Grp123abc" name="track_event[group_name]">' +
  '<select name="track_event[track_id]">' +
  '<option value="11">Main Track</option><option value="12">Mobility &amp; Prep</option></select>';

const builderCalls = (calls) => calls.filter((c) => c.pathname === "/workouts/builder/save");
const definitionOf = (call) => JSON.parse(new URLSearchParams(call.body).get("definition"));

describe("saveWorkoutDefinition (via create_* tools)", () => {
  it("sends the definition as a form POST with the CSRF header", async () => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && found("Bench Press : 3-3-3"));
    const client = await freshClient();

    const out = await client.createSetsWorkout({ ...BENCH, sets: 3, reps: 3 });

    assert.equal(out.workoutId, 9385);
    assert.equal(out.existing, true);
    const [call] = builderCalls(calls);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-CSRF-Token"], "csrf1");
    assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
    const def = definitionOf(call);
    assert.equal(def.prescription.type, "weightlifting/sets");
    assert.equal(def.prescription.scoring, "totalWeight");
    assert.equal(def.contents.length, 3);
  });

  it("carries a rotated cookie from the save into the next write", async () => {
    const { calls } = installFakeBtwb((req) =>
      req.pathname === "/workouts/builder/save"
        ? reply("Workout Found: X (id: 5)", { cookies: ["_btwb_session_id=after-save; Path=/"] })
        : undefined
    );
    const client = await freshClient();

    await client.createSetsWorkout({ ...BENCH, sets: 1, reps: 5 });
    await client.deleteWeighIn(9);

    const del = writes(calls).find((c) => c.pathname === "/weigh_ins/9");
    assert.match(del.headers.Cookie, /_btwb_session_id=after-save/);
  });

  it("reads workout names that contain parentheses", async () => {
    installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && found("Fran (Scaled) : 21-15-9", 321));
    const client = await freshClient();

    const out = await client.createSetsWorkout({ ...BENCH, sets: 1, reps: 5 });

    assert.equal(out.workoutId, 321);
    assert.equal(out.workoutName, "Fran (Scaled) : 21-15-9");
  });

  it("reports needsName instead of creating when no name is given", async () => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && newForm());
    const client = await freshClient();

    const out = await client.createSetsWorkout({ ...BENCH, sets: 3, reps: 3 });

    assert.equal(out.needsName, true);
    assert.equal(writes(calls).filter((c) => c.pathname === "/workouts").length, 0);
  });

  it("creates with the form's own token in both header and body", async () => {
    const { calls } = installFakeBtwb((req) => {
      if (req.pathname === "/workouts/builder/save") return newForm("form-token");
      if (req.pathname === "/workouts") {
        return reply("", { status: 302, headers: { location: "/workouts/55-my-bench" } });
      }
    });
    const client = await freshClient();

    const out = await client.createSetsWorkout({ ...BENCH, sets: 3, reps: 3, name: "My Bench" });

    assert.equal(out.created, true);
    assert.equal(out.workoutId, 55);
    const create = calls.find((c) => c.pathname === "/workouts");
    assert.equal(create.headers["X-CSRF-Token"], "form-token");
    assert.equal(new URLSearchParams(create.body).get("authenticity_token"), "form-token");
    assert.equal(new URLSearchParams(create.body).get("workout[name]"), "My Bench");
  });

  it("fails when the create answers 200 (form re-rendered with errors)", async () => {
    installFakeBtwb((req) => {
      if (req.pathname === "/workouts/builder/save") return newForm();
      if (req.pathname === "/workouts") return reply("<div>Name can't be blank</div>");
    });
    const client = await freshClient();

    await assert.rejects(
      client.createSetsWorkout({ ...BENCH, sets: 3, reps: 3, name: "x" }),
      /create failed: HTTP 200/
    );
  });

  it("does not retry a builder save that answers with the signed-out page", async () => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && reply("<html>sign in</html>", { status: 422 }));
    const client = await freshClient();

    await assert.rejects(client.createSetsWorkout({ ...BENCH, sets: 3, reps: 3 }), /HTTP 422/);
    assert.equal(builderCalls(calls).length, 1);
  });
});

describe("prescriptions", () => {
  const capture = async (fn) => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && found("Found"));
    const client = await freshClient();
    await fn(client);
    return definitionOf(builderCalls(calls)[0]);
  };

  it("%1RM sets score as completed and carry onerepmax weights per set", async () => {
    const def = await capture((c) =>
      c.createSetsWorkout({
        ...BENCH,
        setScheme: [{ reps: 5, percent: 65 }, { reps: 5, percent: 75 }, { reps: 5, percent: 85 }],
      })
    );
    assert.equal(def.prescription.scoring, "completed");
    assert.equal(def.prescription.weightPerSet, "onerepmax");
    assert.deepEqual(def.contents.map((m) => m.weight), [65, 75, 85].map((value) => ({ value, unit: "onerepmax" })));
  });

  it("max-rep bodyweight sets score totalReps and collect reps only", async () => {
    const def = await capture((c) =>
      c.createSetsWorkout({ movementName: "Ring Dip", movementId: 3, sets: 3, maxReps: true, bodyweight: true })
    );
    assert.equal(def.prescription.type, "gymnastics/sets");
    assert.equal(def.prescription.scoring, "totalReps");
    assert.deepEqual(def.contents[0].inputs, ["reps"]);
    assert.equal(def.contents[0].reps, undefined);
  });

  it("repeats a for-time round once per round", async () => {
    const def = await capture((c) => c.createForTimeWorkout({ rounds: 3, movements: [PULLUP, { ...PULLUP, movementId: 8 }] }));
    assert.equal(def.contents.length, 6);
    assert.equal(def.prescription.type, "forTime");
  });

  it("builds an AMRAP scored on rounds, in seconds", async () => {
    const def = await capture((c) => c.createAmrapWorkout({ minutes: 20, movements: [PULLUP] }));
    assert.deepEqual(def.prescription.time, { value: 1200, unit: "seconds" });
    assert.equal(def.prescription.scoring, "totalRounds");
  });
});

describe("input validation", () => {
  // Every case must reject BEFORE anything is posted to BTWB's shared library.
  const rejects = [
    ["sets: 0", (c) => c.createSetsWorkout({ ...BENCH, sets: 0, reps: 3 }), /sets must be a positive integer/],
    ["fractional sets", (c) => c.createSetsWorkout({ ...BENCH, sets: 2.5, reps: 3 }), /positive integer/],
    ["reps: 0", (c) => c.createSetsWorkout({ ...BENCH, sets: 3, reps: 0 }), /positive integer reps/],
    ["negative reps", (c) => c.createSetsWorkout({ ...BENCH, sets: 3, reps: -5 }), /positive integer reps/],
    [
      "mixed percent and no percent",
      (c) => c.createSetsWorkout({ ...BENCH, setScheme: [{ reps: 5, percent: 70 }, { reps: 5 }] }),
      /every set has a percent or none/,
    ],
    ["empty amrap movements", (c) => c.createAmrapWorkout({ minutes: 10, movements: [] }), /at least one movement/],
    ["amrap NaN minutes", (c) => c.createAmrapWorkout({ minutes: NaN, movements: [PULLUP] }), /positive minutes/],
    ["movement without an id", (c) => c.createAmrapWorkout({ minutes: 10, movements: [{ movementName: "x" }] }), /movementId/],
    ["for-time rounds: 0", (c) => c.createForTimeWorkout({ rounds: 0, movements: [PULLUP] }), /rounds must be/],
    ["for-time no movements", (c) => c.createForTimeWorkout({ movements: undefined }), /at least one movement/],
    ["for-distance sets: 0", (c) => c.createForDistanceWorkout({ ...BENCH, sets: 0, durationSeconds: 600 }), /sets must be/],
    ["for-distance no duration", (c) => c.createForDistanceWorkout({ ...BENCH }), /durationSeconds/],
    ["intervals fractional", (c) => c.createIntervalsWorkout({ ...BENCH, intervals: 2.5, distance: 400 }), /positive integer intervals/],
    ["intervals negative", (c) => c.createIntervalsWorkout({ ...BENCH, intervals: -4, distance: 400 }), /positive integer intervals/],
    ["intervals bad rest", (c) => c.createIntervalsWorkout({ ...BENCH, intervals: 4, distance: 400, restSeconds: 100 }), /restSeconds/],
  ];

  for (const [label, call, pattern] of rejects) {
    it(`rejects ${label} without any request`, async () => {
      const { calls } = installFakeBtwb();
      const client = await freshClient();

      await assert.rejects(call(client), pattern);
      assert.equal(calls.length, 0);
    });
  }
});

describe("scheduling", () => {
  const planRoute = (req) =>
    req.pathname === "/plan/track_events/workouts/9385/new" && reply(planPage, { cookies: ["_btwb_session_id=plan-page; Path=/"] });
  const scheduleRoute = (req) =>
    req.pathname === "/plan/track_events/workouts" &&
    req.method === "POST" &&
    reply("", { status: 302, headers: { location: "/plan/track_events/workouts/77" } });

  it("getTracks reads the plan form and decodes track names", async () => {
    installFakeBtwb(planRoute);
    const client = await freshClient();

    const out = await client.getTracks({ workoutId: 9385 });

    assert.deepEqual(out.tracks, [
      { trackId: 11, name: "Main Track" },
      { trackId: 12, name: "Mobility & Prep" },
    ]);
  });

  it("schedules with the plan page's own token and its rotated cookie", async () => {
    const { calls } = installFakeBtwb((req) => planRoute(req) || scheduleRoute(req));
    const client = await freshClient();

    const out = await client.scheduleWorkout({ workoutId: 9385, trackId: 11, date: "2026-10-01" });

    assert.equal(out.trackEventId, 77);
    assert.equal(out.groupName, "Grp123abc");
    const post = writes(calls)[0];
    assert.equal(post.headers["X-CSRF-Token"], "plan-csrf");
    assert.match(post.headers.Cookie, /_btwb_session_id=plan-page/);
    const form = new URLSearchParams(post.body);
    assert.equal(form.get("authenticity_token"), "plan-csrf");
    assert.equal(form.get("track_event[event_date]"), "2026-10-01");
    assert.equal(form.get("track_event[track_id]"), "11");
    assert.equal(form.get("track_event[task_id]"), "9385");
  });

  it("carries the cookie rotated by the schedule POST into the next write", async () => {
    const { calls } = installFakeBtwb(
      (req) =>
        planRoute(req) ||
        (req.pathname === "/plan/track_events/workouts" &&
          reply("", {
            status: 302,
            headers: { location: "/plan/track_events/workouts/77" },
            cookies: ["_btwb_session_id=after-schedule; Path=/"],
          }))
    );
    const client = await freshClient();

    await client.scheduleWorkout({ workoutId: 9385, trackId: 11, date: "2026-10-01" });
    await client.deleteTrackEvent(77);

    // deleteTrackEvent first loads /whiteboard for a token, which is the very
    // next request after the schedule POST.
    const next = calls[calls.findIndex((c) => c.pathname === "/plan/track_events/workouts" && c.method === "POST") + 1];
    assert.equal(next.pathname, "/whiteboard");
    assert.match(next.headers.Cookie, /_btwb_session_id=after-schedule/);
  });

  it("lists the available tracks when no trackId is given", async () => {
    installFakeBtwb(planRoute);
    const client = await freshClient();

    await assert.rejects(client.scheduleWorkout({ workoutId: 9385, date: "2026-10-01" }), /11 \(Main Track\)/);
  });

  for (const [label, args, pattern] of [
    ["a badly formatted date", { workoutId: 9385, trackId: 11, date: "10/01/2026" }, /YYYY-MM-DD/],
    ["an impossible date", { workoutId: 9385, trackId: 11, date: "2026-02-31" }, /YYYY-MM-DD/],
    ["a missing date", { workoutId: 9385, trackId: 11 }, /YYYY-MM-DD/],
    ["a non-numeric workoutId", { workoutId: "abc", trackId: 11, date: "2026-10-01" }, /workoutId/],
    ["a non-alphanumeric groupName", { workoutId: 9385, trackId: 11, date: "2026-10-01", groupName: "a-b" }, /alphanumeric/],
  ]) {
    it(`rejects ${label} without posting`, async () => {
      const { calls } = installFakeBtwb(planRoute);
      const client = await freshClient();

      await assert.rejects(client.scheduleWorkout(args), pattern);
      assert.equal(writes(calls).length, 0);
    });
  }

  it("does not treat a 422 from scheduling as success", async () => {
    installFakeBtwb((req) => planRoute(req) || (req.pathname === "/plan/track_events/workouts" && reply("bad", { status: 422 })));
    const client = await freshClient();

    await assert.rejects(client.scheduleWorkout({ workoutId: 9385, trackId: 11, date: "2026-10-01" }), /HTTP 422/);
  });
});

describe("deleteTrackEvent", () => {
  it("sends a DELETE with the CSRF token and no body", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    const out = await client.deleteTrackEvent(77);

    assert.deepEqual(out, { success: true, trackEventId: 77 });
    const del = writes(calls)[0];
    assert.equal(del.pathname, "/plan/track_events/77");
    assert.equal(del.method, "DELETE");
    assert.equal(del.headers["X-CSRF-Token"], "csrf1");
    assert.equal(del.headers.Accept, "text/html");
    assert.equal(del.body, undefined);
  });

  it("rejects a non-numeric id without any request", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    await assert.rejects(client.deleteTrackEvent("../workouts/9"), /positive integer/);
    assert.equal(calls.length, 0);
  });
});
