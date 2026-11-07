// Offline tests for the multiple/emom builder and logger ("every interval, do
// all of these movements"). Like the other suites they run against a fake
// fetch, so they pin down the request shape and input validation; the real
// BTWB wire format was taken from its own builder bundle and verified live
// with a throwaway entry (see CLAUDE.md).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshClient, installFakeBtwb, reply, useFakeEnv, writes } from "./support/fake-btwb.js";

useFakeEnv();

const BENCH = { movementName: "Bench Press", movementId: 54, reps: 10, weight: 135 };
const PULLUP = { movementName: "Strict Pull-up", movementId: 77, reps: 3 };

const found = (name, id = 4242) => reply(`<h2>Workout Found: ${name} (id: ${id})</h2>`);
const newForm = (token = "form-token") =>
  reply(`<form id="new-workout-form"><input name="authenticity_token" value="${token}"></form>`);
const builderCalls = (calls) => calls.filter((c) => c.pathname === "/workouts/builder/save");
const definitionOf = (call) => JSON.parse(new URLSearchParams(call.body).get("definition"));

const logPage = (prescription, contents) =>
  reply(
    `<meta name="csrf-token" content="csrf1"><script>var uiobject = ${JSON.stringify({ prescription, contents })};</script>`
  );
// A Response body can only be read once, so build a fresh page per request.
const withPage = (makePage) => (req) => (req.pathname.endsWith("/workout_sessions/new") ? makePage() : undefined);
const postedUiobject = (calls) =>
  JSON.parse(new URLSearchParams(writes(calls)[0].body).get("workout_session[uiobject]"));

const multiEmom = {
  type: "multiple/emom",
  every: { value: 60, unit: "seconds" },
  until: { value: 360, unit: "seconds" },
  inputs: ["rounds"],
  scoring: "totalRounds",
};
const emomContents = [
  {
    type: "movement", movementName: "Bench Press", movementId: 54,
    reps: { value: 10, unit: "reps" }, weight: { value: 135, unit: "lbs" },
  },
  { type: "movement", movementName: "Strict Pull-up", movementId: 77, reps: { value: 3, unit: "reps" } },
];

describe("createMultiEmomWorkout", () => {
  it("posts a multiple/emom definition scored on total rounds", async () => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && found("Every 1:00 for 6:00"));
    const client = await freshClient();

    const out = await client.createMultiEmomWorkout({ untilSeconds: 360, movements: [BENCH, PULLUP] });

    assert.equal(out.workoutId, 4242);
    assert.equal(out.existing, true);
    const def = definitionOf(builderCalls(calls)[0]);
    assert.deepEqual(def.prescription, multiEmom);
    assert.deepEqual(def.contents, emomContents);
  });

  it("reports needsName instead of creating when no name is given", async () => {
    const { calls } = installFakeBtwb((req) => req.pathname === "/workouts/builder/save" && newForm());
    const client = await freshClient();

    const out = await client.createMultiEmomWorkout({ untilSeconds: 360, movements: [BENCH, PULLUP] });

    assert.equal(out.needsName, true);
    assert.equal(writes(calls).filter((c) => c.pathname === "/workouts").length, 0);
  });

  it("rejects bad times and empty or malformed movement lists before any request", async () => {
    const { calls } = installFakeBtwb();
    const client = await freshClient();

    await assert.rejects(client.createMultiEmomWorkout({ untilSeconds: 60, movements: [BENCH] }), /greater than everySeconds/);
    await assert.rejects(client.createMultiEmomWorkout({ everySeconds: 0, untilSeconds: 360, movements: [BENCH] }), /everySeconds/);
    await assert.rejects(client.createMultiEmomWorkout({ untilSeconds: 360, movements: [] }), /at least one movement/);
    await assert.rejects(
      client.createMultiEmomWorkout({ untilSeconds: 360, movements: [{ movementName: "Bench Press" }] }),
      /movementId/
    );
    assert.equal(builderCalls(calls).length, 0);
  });
});

describe("logMultiEmomWorkout", () => {
  it("posts the rounds completed, scored totalRounds, privately", async () => {
    const { calls } = installFakeBtwb(withPage(() => logPage(multiEmom, emomContents)));
    const client = await freshClient();

    await client.logMultiEmomWorkout({
      workoutId: 4242, workoutSlug: "every-1-00-for-6-00", rounds: 6, performedDate: "2026-11-07", rxd: true,
    });

    const ui = postedUiobject(calls);
    assert.equal(ui.type, "workoutSession");
    assert.equal(ui.execution.type, "multiple/emom");
    assert.deepEqual(ui.execution.every, multiEmom.every);
    assert.deepEqual(ui.execution.until, multiEmom.until);
    assert.deepEqual(ui.execution.inputs, { rounds: 6 });
    assert.equal(ui.execution.scoring, "totalRounds");
    assert.deepEqual(ui.execution.result, { totalRounds: 6 });
    assert.deepEqual(ui.contents, emomContents);
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[privacy]"), "onlyme");
    assert.equal(form.get("workout_session[rxd]"), "true");
  });

  it("applies a load override by position and keeps the notes and track event", async () => {
    const { calls } = installFakeBtwb(withPage(() => logPage(multiEmom, emomContents)));
    const client = await freshClient();

    await client.logMultiEmomWorkout({
      workoutId: 4242, workoutSlug: "x", rounds: 5, performedDate: "2026-11-07", rxd: false,
      loads: [{ weight: 115 }], notes: "felt good", trackEventId: 99,
    });

    const ui = postedUiobject(calls);
    assert.deepEqual(ui.contents[0].weight, { value: 115, unit: "lbs" });
    assert.deepEqual(ui.contents[1], emomContents[1]);
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[rxd]"), "false");
    assert.equal(form.get("workout_session[notes_plain_text]"), "felt good");
    assert.deepEqual(form.getAll("track_event_ids[]"), ["99"]);
  });

  it("rejects rounds outside 1..ceil(until/every) and non-integers", async () => {
    installFakeBtwb(withPage(() => logPage(multiEmom, emomContents)));
    const client = await freshClient();
    const base = { workoutId: 4242, workoutSlug: "x", performedDate: "2026-11-07" };

    await assert.rejects(client.logMultiEmomWorkout({ ...base, rounds: 7 }), /1 to 6/);
    await assert.rejects(client.logMultiEmomWorkout({ ...base, rounds: 0 }), /1 to 6/);
    await assert.rejects(client.logMultiEmomWorkout({ ...base, rounds: 2.5 }), /1 to 6/);
  });

  it("rejects other prescription types, including the sibling EMOM types", async () => {
    installFakeBtwb(withPage(() => logPage({ type: "alternating/emom", every: { value: 60 }, until: { value: 600 } }, emomContents)));
    let client = await freshClient();
    await assert.rejects(
      client.logMultiEmomWorkout({ workoutId: 1, workoutSlug: "x", rounds: 3, performedDate: "2026-11-07" }),
      /only handles multiple\/emom/
    );

    installFakeBtwb(withPage(() => logPage({ type: "single/emom" }, emomContents)));
    client = await freshClient();
    await assert.rejects(
      client.logMultiEmomWorkout({ workoutId: 1, workoutSlug: "x", rounds: 3, performedDate: "2026-11-07" }),
      /Use log_sets_workout/
    );
  });
});
