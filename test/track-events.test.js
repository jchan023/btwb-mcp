// getTrackEvents scrapes BTWB's whiteboard week view. These tests use a small
// fake of that markup (header toggle, track legend, day boxes) to pin down the
// day-box lookup - not BTWB's real page, which still has to be checked by hand.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshClient, installFakeBtwb, reply, useFakeEnv } from "./support/fake-btwb.js";

useFakeEnv();

const TODAY = "2026-09-30";

const legend =
  '<li data-track-events="track_791545" data-color-name="purple" class="purple">\n' +
  '  <span class="icon-dot-purple"></span>\n  CrossFit Class Programming\n</li>';

const eventItem = (id, title) =>
  `<li class="purple track_791545">\n<div class="view-task-details track_event"\n` +
  `  data-task="workout"\n  data-uri="/tasks/members/42/track_events/${id}">${title}</div>\n</li>`;

const dayBox = (date, label, items) =>
  '<div class="box box-day   current-month">\n' +
  `<a style="text-decoration: none;" data-remote="true" href="/members/42/whiteboard/day?d=${date}">\n` +
  `<h3 class="view-day" title="view day">${label}</h3>\n</a>\n` +
  `<ul class="event-list">${items}</ul>\n</div>`;

// The Day/Week/Month toggle always links to TODAY's date, whichever date was
// requested. That link comes before every day box on the page.
const weekPage = [
  '<meta name="csrf-token" content="csrf1">',
  `<span><a class="btn" data-remote="true" href="/members/42/whiteboard/day?d=${TODAY}">Day</a></span>`,
  legend,
  dayBox("2026-09-29", "Tue | 29", eventItem(111, "Yesterday WOD")),
  dayBox(TODAY, "Wed | 30", eventItem(222, "Today WOD")),
  dayBox("2026-10-01", "Thu | 1", eventItem(333, "Tomorrow WOD")),
].join("\n");

const route = (req) => {
  if (req.pathname === "/members/42/whiteboard/day") return reply(weekPage);
  if (req.pathname.startsWith("/tasks/members/42/track_events/")) {
    const id = req.pathname.split("/").pop();
    return reply(`<a href="/workouts/9${id}-slug-${id}">workout</a>`);
  }
};

describe("getTrackEvents", () => {
  for (const [name, date, id, title] of [
    ["a past date", "2026-09-29", 111, "Yesterday WOD"],
    ["today, whose date is also in the header's Day toggle", TODAY, 222, "Today WOD"],
    ["a future date", "2026-10-01", 333, "Tomorrow WOD"],
  ]) {
    it(`reads the requested day's box for ${name}`, async () => {
      installFakeBtwb(route);
      const client = await freshClient();

      const out = await client.getTrackEvents({ date });

      assert.equal(out.events.length, 1);
      assert.equal(out.events[0].trackEventId, id);
      assert.equal(out.events[0].title, title);
      assert.equal(out.events[0].trackName, "CrossFit Class Programming");
      assert.equal(out.events[0].workoutId, Number(`9${id}`));
    });
  }

  it("throws when the requested date has no box on the page", async () => {
    installFakeBtwb(route);
    const client = await freshClient();

    await assert.rejects(client.getTrackEvents({ date: "2026-12-25" }), /No 2026-12-25 box/);
  });
});
