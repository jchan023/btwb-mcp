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

describe("logAscendingAmrepsWorkout", () => {
  const ladder = {
    type: "amreps/ascending",
    startReps: { value: 2, unit: "reps" },
    addReps: { value: 2, unit: "reps" },
    time: { value: 480, unit: "seconds" },
    inputs: ["rounds"],
    scoring: "totalReps",
  };
  const couplet = [
    { type: "movement", movementName: "Alternating Dumbbell Snatch", movementId: 4605, weight: { value: 50, unit: "lbs" }, inputs: ["reps"] },
    { type: "movement", movementName: "Lateral Burpee Double Jump", movementId: 44872, inputs: ["reps"] },
  ];

  it("posts rounds, per-movement partials and the BTWB totalReps, privately", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(ladder, couplet)));
    const client = await freshClient();

    const out = await client.logAscendingAmrepsWorkout({
      workoutId: 3, workoutSlug: "cheat-code", rounds: 6, extraReps: 14, performedDate: "2026-11-02",
      rxd: false, trackEventId: 344853724,
    });

    const ui = postedUiobject(calls);
    assert.equal(ui.execution.type, "amreps/ascending");
    assert.equal(ui.execution.scoring, "totalReps");
    assert.equal(ui.execution.inputs.rounds, 6);
    // rounds 1-6 = (2+4+6+8+10+12) x 2 movements = 84, plus 14 partial reps.
    assert.equal(ui.execution.result.totalReps, 98);
    assert.equal(out.totalReps, 98);
    assert.deepEqual(ui.contents.map((c) => c.inputs.reps.value), [14, 0]);
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[privacy]"), "onlyme");
    assert.equal(form.get("workout_session[rxd]"), "false");
    assert.equal(form.get("track_event_ids[]"), "344853724");
  });

  it("spills extra reps into the next movement and applies a load override", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(ladder, couplet)));
    const client = await freshClient();

    const out = await client.logAscendingAmrepsWorkout({
      workoutId: 3, workoutSlug: "cheat-code", rounds: 2, extraReps: 9, performedDate: "2026-11-02",
      loads: [{ weight: 35 }],
    });

    const ui = postedUiobject(calls);
    // next round is 6 reps each: 6 snatches then 3 burpees; (2+4) x 2 + 9 = 21.
    assert.deepEqual(ui.contents.map((c) => c.inputs.reps.value), [6, 3]);
    assert.equal(ui.contents[0].weight.value, 35);
    assert.equal(out.totalReps, 21);
  });

  it("rejects bad scores, other prescription types and non-movement items", async () => {
    installFakeBtwb(withPage(logPage(ladder, couplet)));
    let client = await freshClient();
    await assert.rejects(
      client.logAscendingAmrepsWorkout({ workoutId: 3, workoutSlug: "x", rounds: 1, extraReps: 13, performedDate: "2026-11-02" }),
      /more than one full round/
    );
    await assert.rejects(
      client.logAscendingAmrepsWorkout({ workoutId: 3, workoutSlug: "x", rounds: 1.5, performedDate: "2026-11-02" }),
      /whole number/
    );
    installFakeBtwb(withPage(logPage({ type: "amrap" }, couplet)));
    client = await freshClient();
    await assert.rejects(
      client.logAscendingAmrepsWorkout({ workoutId: 3, workoutSlug: "x", rounds: 1, performedDate: "2026-11-02" }),
      /only handles amreps\/ascending/
    );
    installFakeBtwb(withPage(logPage(ladder, [...couplet, { type: "rest" }])));
    client = await freshClient();
    await assert.rejects(
      client.logAscendingAmrepsWorkout({ workoutId: 3, workoutSlug: "x", rounds: 1, performedDate: "2026-11-02" }),
      /purely of movements/
    );
  });
});

describe("logTimeEachRoundWorkout", () => {
  const rx = { type: "timeEachRound", rounds: 3, rest: { value: 3, unit: "seconds" }, inputs: ["time"], scoring: "totalTime" };
  const items = [
    { type: "movement", movementName: "Devil Press", movementId: 13838, reps: { value: 6, unit: "reps" }, weight: { value: 50, unit: "lbs" } },
    { type: "movement", movementName: "Wall Walk", movementId: 3082, reps: { value: 3, unit: "reps" } },
  ];

  it("posts one time per round and their sum, privately", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(rx, items)));
    const client = await freshClient();
    const out = await client.logTimeEachRoundWorkout({
      workoutId: 4, workoutSlug: "devil", roundTimesSeconds: [245, 250, 260], performedDate: "2026-11-02",
      rxd: false, loads: [{ weight: 35 }],
    });
    const ui = postedUiobject(calls);
    assert.equal(out.totalTimeSeconds, 755);
    assert.equal(ui.execution.type, "timeEachRound");
    assert.equal(ui.execution.scoring, "totalTime");
    assert.deepEqual(ui.execution.result.totalTime, { value: 755, unit: "seconds" });
    assert.deepEqual(ui.execution.inputs.map((i) => i.time.value), [245, 250, 260]);
    assert.deepEqual(ui.execution.inputs[0].start, { value: 0, unit: "seconds" });
    assert.equal(ui.contents[0].weight.value, 35);
    assert.equal(writes(calls)[0] && new URLSearchParams(writes(calls)[0].body).get("workout_session[privacy]"), "onlyme");
  });

  it("rejects a wrong number of rounds and other types", async () => {
    installFakeBtwb(withPage(logPage(rx, items)));
    let client = await freshClient();
    await assert.rejects(
      client.logTimeEachRoundWorkout({ workoutId: 4, workoutSlug: "x", roundTimesSeconds: [1, 2], performedDate: "2026-11-02" }),
      /exactly 3/
    );
    installFakeBtwb(withPage(logPage({ type: "roundsForTime" }, items)));
    client = await freshClient();
    await assert.rejects(
      client.logTimeEachRoundWorkout({ workoutId: 4, workoutSlug: "x", roundTimesSeconds: [1], performedDate: "2026-11-02" }),
      /only handles timeEachRound/
    );
  });
});

describe("logForTimeWorkout with a time cap (forTime/timeCap)", () => {
  const rx = { type: "forTime/timeCap", timeCap: { time: { value: 2100, unit: "seconds" }, reps: { value: 30, unit: "reps" } }, inputs: ["time"], scoring: "totalTime" };
  const items = [
    { type: "movement", movementName: "Power Clean", movementId: 53, reps: { value: 12, unit: "reps" }, inputs: ["reps"] },
    { type: "movement", movementName: "Toes-to-bar", movementId: 633, reps: { value: 18, unit: "reps" }, inputs: ["reps"] },
  ];

  it("posts a finished time under the cap as totalTime", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(rx, items)));
    const client = await freshClient();
    await client.logForTimeWorkout({ workoutId: 5, workoutSlug: "chip", totalTimeSeconds: 1800, performedDate: "2026-11-02" });
    const ui = postedUiobject(calls);
    assert.equal(ui.execution.scoring, "totalTime");
    assert.deepEqual(ui.execution.inputs.time, { value: 1800, unit: "seconds" });
    assert.deepEqual(ui.execution.timeCap, rx.timeCap);
    assert.equal(ui.contents[0].inputs, undefined);
  });

  it("posts a capped result with reps filled in prescription order and BTWB's time-equivalent", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(rx, items)));
    const client = await freshClient();
    await client.logForTimeWorkout({ workoutId: 5, workoutSlug: "chip", repsCompleted: 15, performedDate: "2026-11-02" });
    const ui = postedUiobject(calls);
    assert.equal(ui.execution.scoring, "timeCapped");
    assert.deepEqual(ui.execution.result.totalReps, { value: 15, unit: "reps" });
    // cap + totalReps - repsCompleted = 2100 + 30 - 15
    assert.deepEqual(ui.execution.result.totalTime, { value: 2115, unit: "seconds" });
    assert.deepEqual(ui.contents.map((c) => c.inputs.reps.value), [12, 3]);
  });

  it("leaves unreached movements blank", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(rx, items)));
    const client = await freshClient();
    await client.logForTimeWorkout({ workoutId: 5, workoutSlug: "chip", repsCompleted: 5, performedDate: "2026-11-02" });
    assert.deepEqual(postedUiobject(calls).contents.map((c) => c.inputs.reps.value), [5, ""]);
  });

  it("validates exactly-one-of totalTimeSeconds/repsCompleted, the rep range and the cap", async () => {
    const cases = [
      [{}, /exactly one of/],
      [{ totalTimeSeconds: 1800, repsCompleted: 5 }, /exactly one of/],
      [{ repsCompleted: 30 }, /whole number from 0 to 29/],
      [{ totalTimeSeconds: 2200 }, /over the 2100s time cap/],
    ];
    for (const [args, message] of cases) {
      installFakeBtwb(withPage(logPage(rx, items)));
      const client = await freshClient();
      await assert.rejects(
        client.logForTimeWorkout({ workoutId: 5, workoutSlug: "chip", performedDate: "2026-11-02", ...args }),
        message
      );
    }
  });

  it("still requires a time for plain For Time workouts", async () => {
    installFakeBtwb(withPage(logPage({ type: "forTime" }, items)));
    const client = await freshClient();
    await assert.rejects(
      client.logForTimeWorkout({ workoutId: 5, workoutSlug: "x", performedDate: "2026-11-02" }),
      /totalTimeSeconds is required/
    );
  });
});

describe("logEffortSetsWorkout", () => {
  const dips = (n) => Array.from({ length: n }, () => ({ type: "movement", movementName: "Ring Dip (Strict)", movementId: 2422, inputs: ["reps"] }));
  const rows = (n) => Array.from({ length: n }, () => ({ type: "movement", movementName: "Row", movementId: 6, distance: { value: 1500, unit: "m" }, inputs: ["time"] }));

  it("sums reps for gymnastics/sets", async () => {
    const { calls } = installFakeBtwb(withPage(logPage({ type: "gymnastics/sets", scoring: "totalReps" }, dips(3))));
    const client = await freshClient();
    const out = await client.logEffortSetsWorkout({
      workoutId: 6, workoutSlug: "dips", sets: [{ reps: 5 }, { reps: 4 }, { reps: 3 }], performedDate: "2026-11-02",
    });
    const ui = postedUiobject(calls);
    assert.equal(ui.execution.type, "gymnastics/sets");
    assert.equal(ui.execution.scoring, "totalReps");
    assert.equal(ui.execution.result.totalReps, 12);
    assert.equal(out.totals.reps, 12);
    assert.deepEqual(ui.contents.map((c) => c.inputs.reps.value), [5, 4, 3]);
  });

  it("sums time for monostructural/sets and keeps the prescribed rest", async () => {
    const rest = { value: 150, unit: "seconds" };
    const { calls } = installFakeBtwb(withPage(logPage({ type: "monostructural/sets", rest, scoring: "totalTime" }, rows(2))));
    const client = await freshClient();
    await client.logEffortSetsWorkout({
      workoutId: 7, workoutSlug: "row", sets: [{ timeSeconds: 330 }, { timeSeconds: 335 }], performedDate: "2026-11-02",
    });
    const ui = postedUiobject(calls);
    assert.deepEqual(ui.execution.result.totalTime, { value: 665, unit: "seconds" });
    assert.deepEqual(ui.execution.rest, rest);
    assert.deepEqual(ui.contents.map((c) => c.inputs.time.value), [330, 335]);
  });

  it("rejects a wrong set count, a missing input, and other types", async () => {
    installFakeBtwb(withPage(logPage({ type: "gymnastics/sets", scoring: "totalReps" }, dips(3))));
    let client = await freshClient();
    await assert.rejects(
      client.logEffortSetsWorkout({ workoutId: 6, workoutSlug: "x", sets: [{ reps: 5 }], performedDate: "2026-11-02" }),
      /prescribes 3 sets/
    );
    installFakeBtwb(withPage(logPage({ type: "gymnastics/sets", scoring: "totalReps" }, dips(3))));
    client = await freshClient();
    await assert.rejects(
      client.logEffortSetsWorkout({ workoutId: 6, workoutSlug: "x", sets: [{ reps: 5 }, {}, { reps: 1 }], performedDate: "2026-11-02" }),
      /Set 2 needs reps/
    );
    installFakeBtwb(withPage(logPage({ type: "weightlifting/sets" }, dips(1))));
    client = await freshClient();
    await assert.rejects(
      client.logEffortSetsWorkout({ workoutId: 6, workoutSlug: "x", sets: [{ reps: 1 }], performedDate: "2026-11-02" }),
      /only handles gymnastics\/sets and monostructural\/sets/
    );
  });
});

describe("logRoundsMaxRepsWorkout", () => {
  const rx = { type: "roundsForMaxReps", rounds: 3, scoring: "totalReps" };
  const strength = [
    { type: "movement", movementName: "Front Squat", movementId: 26, reps: { value: 10, unit: "reps" }, weight: { value: 0, unit: "pickload" }, inputs: ["weight"] },
    { type: "movement", movementName: "Strict Pull-up", movementId: 108, reps: { value: 0, unit: "maxreps" } },
  ];

  it("posts per-round scores on the max-rep movement, the pick-load weight and the totals", async () => {
    const { calls } = installFakeBtwb(withPage(logPage(rx, strength)));
    const client = await freshClient();
    const out = await client.logRoundsMaxRepsWorkout({
      workoutId: 8, workoutSlug: "rfme", roundScores: [6, 5, 4], loads: [{ weight: 185 }], performedDate: "2026-11-02", rxd: false,
    });
    const ui = postedUiobject(calls);
    assert.equal(out.totalReps, 15);
    assert.deepEqual(ui.execution.result, { totalReps: 15, scores: [6, 5, 4] });
    assert.equal(ui.execution.scoring, "totalReps");
    assert.deepEqual(ui.contents[0].inputs, { weight: { value: 185, unit: "lbs" } });
    assert.deepEqual(ui.contents[1].scores, [6, 5, 4]);
    assert.equal(ui.contents[0].scores, undefined);
    const form = new URLSearchParams(writes(calls)[0].body);
    assert.equal(form.get("workout_session[privacy]"), "onlyme");
  });

  it("sums several max-rep movements per round", async () => {
    const items = [
      { type: "movement", movementName: "Run", movementId: 5, reps: { value: 0, unit: "maxreps" } },
      { type: "movement", movementName: "Handstand Hold", movementId: 11187, time: { value: 15, unit: "seconds" } },
      { type: "movement", movementName: "Ski Erg", movementId: 2115, reps: { value: 0, unit: "maxreps" } },
    ];
    const { calls } = installFakeBtwb(withPage(logPage({ ...rx, rounds: 2 }, items)));
    const client = await freshClient();
    await client.logRoundsMaxRepsWorkout({
      workoutId: 8, workoutSlug: "rfme", roundScores: [[300, 250], [290, 240]], performedDate: "2026-11-02",
    });
    const ui = postedUiobject(calls);
    assert.deepEqual(ui.execution.result, { totalReps: 1080, scores: [550, 530] });
    assert.deepEqual(ui.contents[0].scores, [300, 290]);
    assert.deepEqual(ui.contents[2].scores, [250, 240]);
    assert.equal(ui.contents[1].scores, undefined);
  });

  it("rejects wrong round counts, bad scores, a missing pick-load weight and other types", async () => {
    const cases = [
      [rx, strength, { roundScores: [1, 2], loads: [{ weight: 100 }] }, /exactly 3 entries/],
      [rx, strength, { roundScores: [1, 2, -1], loads: [{ weight: 100 }] }, /Round 3 needs 1 whole-number/],
      [rx, strength, { roundScores: [[1, 2], 2, 3], loads: [{ weight: 100 }] }, /Round 1 needs 1 whole-number/],
      [rx, strength, { roundScores: [1, 2, 3] }, /pick-load/],
      [{ type: "forTime" }, strength, { roundScores: [1, 2, 3] }, /only handles roundsForMaxReps/],
    ];
    for (const [prescription, contents, args, message] of cases) {
      installFakeBtwb(withPage(logPage(prescription, contents)));
      const client = await freshClient();
      await assert.rejects(
        client.logRoundsMaxRepsWorkout({ workoutId: 8, workoutSlug: "x", performedDate: "2026-11-02", ...args }),
        message
      );
    }
  });
});
