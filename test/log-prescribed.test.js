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

  it("rejects an unverified amrap-prefixed sibling type instead of treating it as a plain amrap", async () => {
    // Regression guard: this must stay an exact match on "amrap", not a
    // prefix test - BTWB's prescriptionType taxonomy has amrapBuyIn,
    // amrapMaxRep and amrapRepeats alongside plain "amrap" (issue #7), none
    // of which have been verified to share its structure.
    installFakeBtwb(withPage(logPage({ type: "amrapBuyIn" }, cindy)));
    const client = await freshClient();
    await assert.rejects(
      client.logAmrapWorkout({ workoutId: 2, workoutSlug: "cindy", rounds: 1, performedDate: "2026-10-26" }),
      /only handles AMRAP.*"amrapBuyIn"/
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

  it("rejects an unverified forTime-prefixed sibling type instead of treating it as a plain For Time", async () => {
    // Regression guard: this must stay an exact match on "forTime"/
    // "roundsForTime", not a prefix test - BTWB's prescriptionType taxonomy
    // has rftVaryingReps alongside them (issue #7), an RFT whose rep scheme
    // varies by round (e.g. 21-15-9), which has not been verified to share
    // the fixed-rep structure logForTimeWorkout assumes.
    installFakeBtwb(withPage(logPage({ type: "rftVaryingReps" }, [])));
    const client = await freshClient();
    await assert.rejects(
      client.logForTimeWorkout({ workoutId: 1, workoutSlug: "rft", totalTimeSeconds: 988, performedDate: "2026-10-29" }),
      /only handles For Time and Rounds For Time.*"rftVaryingReps"/
    );
  });
});

describe("getWorkoutPrescription", () => {
  it("returns the raw prescription and contents without posting anything", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(amrap, cindy)));
    const client = await freshClient();

    const result = await client.getWorkoutPrescription({
      workoutId: 2, workoutSlug: "cindy", performedDate: "2026-10-26",
    });

    assert.equal(result.prescriptionType, "amrap");
    assert.equal(result.scoring, "totalRounds");
    assert.deepEqual(result.prescription, amrap);
    assert.deepEqual(result.contents, cindy);
    assert.equal(writes(calls).length, 0);
  });

  it("surfaces an ascending-ladder prescription as-is, untyped by any logger", async () => {
    const ascending = { type: "amreps/ascending", time: { value: 480, unit: "seconds" }, scoring: "rounds+reps" };
    const ladder = [
      { type: "movement", movementName: "Dumbbell Snatch", movementId: 7, reps: { value: null, unit: "ladder" } },
      { type: "movement", movementName: "Lateral Burpee Over Dumbbell", movementId: 24, reps: { value: null, unit: "ladder" } },
    ];
    installFakeBtwb(withPage(logPage(ascending, ladder)));
    const client = await freshClient();

    const result = await client.getWorkoutPrescription({
      workoutId: 19585971, workoutSlug: "cheat-code", performedDate: "2026-11-02",
    });

    assert.equal(result.prescriptionType, "amreps/ascending");
    assert.deepEqual(result.contents, ladder);
  });
});

describe("logTimedRoundsWorkout", () => {
  const remReps = [
    {
      type: "section",
      rounds: 5,
      time: { value: 60, unit: "seconds" },
      contents: [
        { type: "movement", movementName: "Burpee", movementId: 24, reps: { value: 6, unit: "reps" } },
        { type: "movement", movementName: "Echo Bike Calorie", movementId: 19875, reps: { value: 0, unit: "maxreps" } },
        { type: "rest", time: { value: 60, unit: "seconds" } },
      ],
    },
  ];
  const timedRounds = { type: "timedRounds/maxReps", scoring: "totalReps" };
  const args = { workoutId: 19560137, workoutSlug: "remreps", performedDate: "2026-10-30" };

  it("scores the max-rep movement per round, totals them, and posts privately", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(timedRounds, remReps)));
    const client = await freshClient();

    await client.logTimedRoundsWorkout({ ...args, roundScores: [11, 9, 9, 8, 11], rxd: false });

    const ui = postedUiobject(calls);
    assert.equal(ui.execution.type, "timedRounds/maxReps");
    assert.equal(ui.execution.scoring, "totalReps");
    assert.equal(ui.execution.result.totalReps, 48);
    const [section] = ui.contents;
    assert.equal(section.rounds, 5);
    assert.deepEqual(section.contents[1].scores, [11, 9, 9, 8, 11]);
    assert.equal(section.contents[0].scores, undefined);
    assert.equal(section.contents[2].type, "rest");
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[privacy]"), "onlyme");
    assert.equal(form.get("workout_session[rxd]"), "false");
  });

  it("rejects the wrong number of scores, bad scores and other workout types", async () => {
    const attempt = async (prescription, roundScores) => {
      installFakeBtwb(withPage(logPage(prescription, remReps)));
      const client = await freshClient();
      return client.logTimedRoundsWorkout({ ...args, roundScores });
    };
    await assert.rejects(attempt(timedRounds, [11, 9]), /one score per round \(5\)/);
    await assert.rejects(attempt(timedRounds, [11, 9, 9, 8, -1]), /0 or more/);
    await assert.rejects(attempt({ type: "amrap" }, [1, 1, 1, 1, 1]), /only handles timedRounds\/maxReps/);
  });
});
