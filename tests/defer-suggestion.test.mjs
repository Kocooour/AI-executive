import assert from "node:assert/strict";
import test from "node:test";

const { deferTargets, suggestDeferral, addDays } = await import("../lib/defer-suggestion.ts");

// 2026-10-22 is a Thursday; Sat 24th, Sun 25th, Mon 26th.
const TODAY = "2026-10-22";
let counter = 0;
const task = (properties = {}, overrides = {}) => ({
  id: `t${++counter}`, type: "task", title: "Task", status: "open", workspaceId: "personal",
  properties, createdAt: 1000, updatedAt: 1000, ...overrides,
});
const suggest = (subject, others = [], extra = {}) =>
  suggestDeferral({ task: subject, openTasks: [subject, ...others], today: TODAY, ...extra });

test("targets: weekend is the nearest Saturday, next week is the next Monday", () => {
  assert.deepEqual(deferTargets("2026-10-22"), { today: "2026-10-22", tomorrow: "2026-10-23", weekend: "2026-10-24", nextWeek: "2026-10-26" });
  // Monday: weekend ahead, next week is seven days on.
  assert.deepEqual(deferTargets("2026-10-26"), { today: "2026-10-26", tomorrow: "2026-10-27", weekend: "2026-10-31", nextWeek: "2026-11-02" });
  // Saturday and Sunday: the weekend is today; next week is the coming Monday.
  assert.deepEqual(deferTargets("2026-10-24"), { today: "2026-10-24", tomorrow: "2026-10-25", weekend: "2026-10-24", nextWeek: "2026-10-26" });
  assert.deepEqual(deferTargets("2026-10-25"), { today: "2026-10-25", tomorrow: "2026-10-26", weekend: "2026-10-25", nextWeek: "2026-10-26" });
  // Friday.
  assert.equal(deferTargets("2026-10-23").weekend, "2026-10-24");
  assert.equal(deferTargets("2026-10-23").nextWeek, "2026-10-26");
});

test("targets cross month and year boundaries and the autumn clock change", () => {
  assert.deepEqual(deferTargets("2026-12-31"), { today: "2026-12-31", tomorrow: "2027-01-01", weekend: "2027-01-02", nextWeek: "2027-01-04" });
  assert.equal(deferTargets("2026-10-30").nextWeek, "2026-11-02");
  assert.equal(deferTargets("2026-10-30").weekend, "2026-10-31");
  // Daylight-saving ends on 2026-10-25 in Europe; the day count is unaffected.
  assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(deferTargets("2026-10-23").nextWeek, "2026-10-26");
  assert.equal(addDays("2026-03-28", 2), "2026-03-30");
});

test("rule 1: a deadline today, tomorrow or already passed keeps the task today", () => {
  for (const deadline of ["2026-10-23", "2026-10-22", "2026-10-10"]) {
    assert.deepEqual(suggest(task({ deadline, when: TODAY })), { target: TODAY, reason: "deferKeepDeadline", params: { date: deadline } });
  }
  // It outranks everything else, including a long deferral history and waiting.
  const stubborn = task({ deadline: "2026-10-23", waiting: true, followUpDate: "2026-10-30", deferHistory: [1, 2, 3, 4].map(() => ({})) });
  assert.equal(suggest(stubborn).reason, "deferKeepDeadline");
  // A deadline two days away is not "close".
  assert.notEqual(suggest(task({ deadline: "2026-10-24" })).reason, "deferKeepDeadline");
});

test("rule 2: a waiting task goes to its follow-up day, if that is ahead", () => {
  const waiting = task({ waiting: true, waitingFor: "Petr", followUpDate: "2026-10-29" });
  assert.deepEqual(suggest(waiting), { target: "2026-10-29", reason: "deferWaitingFollowUp", params: { who: "Petr", date: "2026-10-29" } });
  assert.equal(suggest(task({ waiting: true, followUpDate: "2026-10-29" })).params.who, "");
  // Follow-up today or earlier, or missing, is not used.
  assert.equal(suggest(task({ waiting: true, followUpDate: TODAY })).reason, "deferDefault");
  assert.equal(suggest(task({ waiting: true, followUpDate: "" })).reason, "deferDefault");
  assert.equal(suggest(task({ waiting: false, followUpDate: "2026-10-29" })).reason, "deferDefault");
  // Not beyond the deadline.
  const late = task({ waiting: true, followUpDate: "2026-11-10", deadline: "2026-10-30" });
  assert.equal(suggest(late).reason, "deferDefault");
});

test("rule 3: deferred three times or more goes to Someday", () => {
  const history = (n) => Array.from({ length: n }, () => ({ from: "2026-10-22", to: "2026-10-23", at: 1, via: "manual" }));
  assert.deepEqual(suggest(task({ deferHistory: history(3) })), { target: "someday", reason: "deferRepeated", params: { n: 3 } });
  assert.equal(suggest(task({ deferHistory: history(10) })).params.n, 10);
  assert.equal(suggest(task({ deferHistory: history(2) })).reason, "deferDefault");
  assert.equal(suggest(task({ deferHistory: "nonsense" })).reason, "deferDefault");
  // Only postponements count: pulling a task earlier or giving an undated task a day is not deferring it.
  const earlier = Array.from({ length: 3 }, () => ({ from: "2026-10-25", to: "2026-10-22", at: 1, via: "manual" }));
  const scheduled = Array.from({ length: 3 }, () => ({ from: null, to: "2026-10-23", at: 1, via: "manual" }));
  assert.equal(suggest(task({ deferHistory: earlier })).reason, "deferDefault");
  assert.equal(suggest(task({ deferHistory: scheduled })).reason, "deferDefault");
  assert.equal(suggest(task({ deferHistory: [{ from: "2026-10-20", to: "someday" }, { from: "2026-10-21", to: null }, { from: "2026-10-22", to: "2026-10-24" }] })).reason, "deferRepeated");
  // A task with a deadline is never sent to Someday.
  assert.notEqual(suggest(task({ deferHistory: history(5), deadline: "2026-11-20" })).target, "someday");
  // Waiting outranks it.
  assert.equal(suggest(task({ deferHistory: history(5), waiting: true, followUpDate: "2026-10-30" })).reason, "deferWaitingFollowUp");
});

test("rule 4: an overloaded Today moves the task to the nearest quiet day", () => {
  const mine = task({ when: TODAY });
  const crowd = Array.from({ length: 6 }, () => task({ when: TODAY }));
  // 7 open tasks in Today (more than 6).
  assert.deepEqual(suggest(mine, crowd), { target: "2026-10-23", reason: "deferOverloaded", params: { todayCount: 7, date: "2026-10-23", dayCount: 0 } });
  // Exactly 6 is not overloaded.
  assert.equal(suggest(mine, crowd.slice(1)).reason, "deferDefault");
  // A calendar that says so is enough.
  assert.equal(suggest(mine, [], { calendarOverloaded: true }).reason, "deferOverloaded");
  // Days with 4 or more planned tasks are skipped; the busy day is counted without the task itself.
  const busyTomorrow = Array.from({ length: 4 }, () => task({ when: "2026-10-23" }));
  const result = suggest(mine, [...crowd, ...busyTomorrow]);
  assert.deepEqual(result.params, { todayCount: 7, date: "2026-10-24", dayCount: 0 });
  const threeTomorrow = busyTomorrow.slice(1);
  assert.equal(suggest(mine, [...crowd, ...threeTomorrow]).params.dayCount, 3);
  // A task that is not in Today does not get this rule, and overdue/flagged tasks count as Today.
  assert.equal(suggest(task({ when: "2026-10-30" }), crowd).reason, "deferDefault");
  assert.equal(suggest(task({ today: true }), crowd).reason, "deferOverloaded");
  // Completed tasks do not count.
  const done = crowd.map((other) => ({ ...other, status: "completed" }));
  assert.equal(suggest(mine, done).reason, "deferDefault");
});

test("rule 4 stays before the deadline and is skipped when there is no room", () => {
  const crowd = Array.from({ length: 6 }, () => task({ when: TODAY }));
  const mine = task({ when: TODAY, deadline: "2026-10-26" });
  assert.equal(suggest(mine, crowd).target, "2026-10-23");
  // Tomorrow and the day after are full: the 25th is before the 26th.
  const full = ["2026-10-23", "2026-10-24"].flatMap((day) => Array.from({ length: 4 }, () => task({ when: day })));
  assert.equal(suggest(mine, [...crowd, ...full]).target, "2026-10-25");
  // Everything before the deadline is full: the rule is skipped and the next one answers (still before the deadline).
  const fuller = ["2026-10-23", "2026-10-24", "2026-10-25"].flatMap((day) => Array.from({ length: 4 }, () => task({ when: day })));
  const skipped = suggest(mine, [...crowd, ...fuller]);
  assert.equal(skipped.reason, "deferDefault");
  assert.ok(skipped.target <= "2026-10-26");
  // Search window is 13 days.
  const allFull = Array.from({ length: 13 }, (_, index) => addDays(TODAY, index + 1))
    .flatMap((day) => Array.from({ length: 4 }, () => task({ when: day })));
  assert.equal(suggest(task({ when: TODAY }), [...crowd, ...allFull]).reason, "deferDefault");
});

test("rule 5: a quiet task waits for next Monday when the week is busy", () => {
  const withDeadlines = [
    task({ deadline: "2026-10-23" }), task({ deadline: "2026-10-25" }), task({ deadline: "2026-10-22" }),
  ];
  assert.deepEqual(suggest(task({}), withDeadlines), { target: "2026-10-26", reason: "deferBusyWeek", params: { n: 3 } });
  assert.equal(suggest(task({ priority: "low" }), withDeadlines).reason, "deferBusyWeek");
  // Only 2 busy tasks: ordinary default.
  assert.equal(suggest(task({}), withDeadlines.slice(1)).reason, "deferDefault");
  // A deadline after this Sunday does not count; a passed one does not either.
  const outside = [task({ deadline: "2026-10-26" }), task({ deadline: "2026-10-21" }), task({ deadline: "2026-11-01" })];
  assert.equal(suggest(task({}), outside).reason, "deferDefault");
  // High priority in Today counts, high priority elsewhere does not; both together count once.
  const highToday = [task({ priority: "high", when: TODAY }), task({ priority: "high", when: TODAY }), task({ priority: "high", today: true })];
  assert.equal(suggest(task({}), highToday).reason, "deferBusyWeek");
  const highLater = [task({ priority: "high", when: "2026-10-28" }), task({ priority: "high" }), task({ priority: "high", when: "2026-10-30" })];
  assert.equal(suggest(task({}), highLater).reason, "deferDefault");
  const both = [task({ priority: "high", when: TODAY, deadline: "2026-10-23" }), task({ deadline: "2026-10-24" })];
  assert.equal(suggest(task({}), both).reason, "deferDefault");
  // The task itself never counts, and a medium/high priority or a deadline switches the rule off.
  assert.equal(suggest(task({ priority: "medium" }), withDeadlines).reason, "deferDefault");
  assert.equal(suggest(task({ deadline: "2026-11-20" }), withDeadlines).reason, "deferDefault");
  // On a Sunday the week ends today.
  const sunday = suggestDeferral({ task: task({}), openTasks: [task({ deadline: "2026-10-25" }), task({ deadline: "2026-10-25" }), task({ deadline: "2026-10-25" })], today: "2026-10-25" });
  assert.equal(sunday.reason, "deferBusyWeek");
  assert.equal(sunday.target, "2026-10-26");
});

test("rule 6: otherwise tomorrow", () => {
  assert.deepEqual(suggest(task({})), { target: "2026-10-23", reason: "deferDefault", params: {} });
  assert.deepEqual(suggest(task({ when: TODAY, deadline: "2026-10-24" })), { target: "2026-10-23", reason: "deferDefault", params: {} });
});

test("never suggests a date after the deadline", () => {
  const crowd = Array.from({ length: 8 }, () => task({ when: TODAY }));
  const deadlines = ["2026-10-10", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-11-05", "2027-01-01"];
  for (const deadline of deadlines) {
    for (const extra of [{}, { waiting: true, followUpDate: "2026-12-01" }, { priority: "low" }]) {
      for (const overloaded of [false, true]) {
        const result = suggest(task({ when: TODAY, deadline, ...extra }), crowd, { calendarOverloaded: overloaded });
        assert.ok(result, "a suggestion exists");
        if (result.target !== "someday") assert.ok(result.target <= (deadline > TODAY ? deadline : TODAY), `${result.reason} ${result.target} vs ${deadline}`);
      }
    }
  }
});

test("only open tasks get a suggestion, and the answer does not depend on the clock", () => {
  assert.equal(suggest(task({}, { status: "completed" })), null);
  assert.equal(suggest(task({}, { type: "note" })), null);
  const subject = task({ when: TODAY });
  assert.deepEqual(suggest(subject), suggest(subject));
  // Another day pinned: a Saturday.
  const saturday = suggestDeferral({ task: task({}), openTasks: [], today: "2026-10-24" });
  assert.equal(saturday.target, "2026-10-25");
});
