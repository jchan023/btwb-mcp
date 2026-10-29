// Offline tests for the prescribed-workout loggers (AMRAP, EMOM). The Log page
// is faked with a minimal `var uiobject` prescription; real markup still needs
// a live throwaway check (see CLAUDE.md).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshClient, installFakeBtwb, reply, useFakeEnv, writes } from "./support/fake-btwb.js";

useFakeEnv();

const logPage = (prescription, contents) =>
  reply(
    `<meta name="csrf-token" content="csrf1"><script>var uiobject = ${JSON.stringify({ prescription, contents })};</script>`
  );
const withPage = (page) => (req) => (req.pathname.endsWith("/workout_sessions/new") ? page : undefined);
const postedUiobject = (calls) =>
  JSON.parse(new URLSearchParams(writes(calls)[0].body).get("workout_session[uiobject]"));

const cindy = [
  { type: "movement", movementName: "Pull-up", movementId: 1, reps: { value: 5, unit: "reps" } },
  { type: "movement", movementName: "Push-up", movementId: 2, reps: { value: 10, unit: "reps" } },
  { type: "movement", movementName: "Air Squat", movementId: 3, reps: { value: 15, unit: "reps" } },
];
const amrap = { type: "amrap", time: { value: 1200, unit: "seconds" }, inputs: ["rounds"], scoring: "totalRounds" };

describe("logAmrapWorkout", () => {
  it("posts rounds, per-movement partials and a numeric totalRounds, privately", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(amrap, cindy)));
    const client = await freshClient();

    await client.logAmrapWorkout({
      workoutId: 2, workoutSlug: "cindy", rounds: 4, extraReps: 15, performedDate: "2026-10-26", rxd: false,
    });

    const ui = postedUiobject(calls);
    assert.equal(ui.execution.inputs.rounds, 4);
    assert.deepEqual(ui.contents.map((c) => c.partials.reps), [5, 10, 0]);
    assert.equal(ui.execution.result.totalRounds, 4 + (1 + 1 + 0) / 3);
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[privacy]"), "onlyme");
    assert.equal(form.get("workout_session[rxd]"), "false");
  });

  it("rejects extra reps beyond one round and non-AMRAP workouts", async () => {
    installFakeBtwb(withPage(logPage(amrap, cindy)));
    let client = await freshClient();
    await assert.rejects(
      client.logAmrapWorkout({ workoutId: 2, workoutSlug: "cindy", rounds: 1, extraReps: 31, performedDate: "2026-10-26" }),
      /more than one full round/
    );
    installFakeBtwb(withPage(logPage({ type: "forTime" }, cindy)));
    client = await freshClient();
    await assert.rejects(
      client.logAmrapWorkout({ workoutId: 2, workoutSlug: "cindy", rounds: 1, performedDate: "2026-10-26" }),
      /only handles AMRAP/
    );
  });
});

describe("logSetsWorkout", () => {
  it("accepts single/emom workouts", async () => {
    const sets = [1, 2].map(() => ({ type: "movement", movementName: "Front Squat", movementId: 26, reps: { value: 3, unit: "reps" } }));
    const { calls } = installFakeBtwb(withPage(logPage({ type: "single/emom" }, sets)));
    const client = await freshClient();

    await client.logSetsWorkout({
      workoutId: 1, workoutSlug: "emom", sets: [{ weight: 165 }, { weight: 175 }], performedDate: "2026-10-26",
    });

    const ui = postedUiobject(calls);
    assert.equal(ui.execution.type, "single/emom");
    assert.deepEqual(ui.contents.map((c) => c.inputs.weight.value), [165, 175]);
  });
});

describe("complex EMOM and rounds-for-time", () => {
  it("logs a totalWeight EMOM of complex items with the summed weight", async () => {
    const items = [1, 2].map(() => ({ type: "complex", reps: { value: 1, unit: "reps" }, movements: [] }));
    const { calls } = installFakeBtwb(
      withPage(logPage({ type: "single/emom", scoring: "totalWeight" }, items))
    );
    const client = await freshClient();

    await client.logSetsWorkout({
      workoutId: 1, workoutSlug: "emom", sets: [{ weight: 65 }, { weight: 75 }], performedDate: "2026-10-29",
    });

    const ui = postedUiobject(calls);
    assert.deepEqual(ui.execution.result.totalWeight, { value: 140, unit: "lbs" });
    assert.deepEqual(ui.contents.map((c) => c.inputs.weight.value), [65, 75]);
  });

  it("logs a roundsForTime workout with its rounds and a load override", async () => {
    const items = [
      { type: "movement", movementName: "Hang Power Snatch", reps: { value: 8, unit: "reps" }, weight: { value: 95, unit: "lbs" } },
      { type: "movement", movementName: "Double Under", reps: { value: 48, unit: "reps" } },
    ];
    const { calls } = installFakeBtwb(withPage(logPage({ type: "roundsForTime", rounds: 4 }, items)));
    const client = await freshClient();

    await client.logForTimeWorkout({
      workoutId: 1, workoutSlug: "rft", totalTimeSeconds: 988, performedDate: "2026-10-29", rxd: false, loads: [{ weight: 75 }],
    });

    const ui = postedUiobject(calls);
    assert.equal(ui.execution.rounds, 4);
    assert.equal(ui.execution.result.totalTime.value, 988);
    assert.equal(ui.contents[0].weight.value, 75);
  });
});
