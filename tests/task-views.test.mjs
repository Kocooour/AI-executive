import assert from "node:assert/strict";
import test from "node:test";

const { byManualOrder, manualOrder, newTaskPlacement, parseCaptureText, taskDueTone, taskMatchesView } = await import("../lib/task-views.ts");

// Local-time constructor: these helpers work on the device's local calendar day.
const NOW = new Date(2026, 9, 7, 10, 0, 0);
const TODAY = "2026-10-07";
const task = (overrides = {}) => ({
  id: "t1", type: "task", title: "Task", status: "open", workspaceId: "personal",
  properties: {}, createdAt: 1000, updatedAt: 1000, ...overrides,
});

test("view membership follows the documented working views", () => {
  const inbox = task({ properties: { inbox: true } });
  const flaggedToday = task({ properties: { today: true } });
  const dueToday = task({ properties: { when: TODAY } });
  const overdue = task({ properties: { when: "2026-10-01" } });
  const upcoming = task({ properties: { when: "2026-10-20" } });
  const anytime = task();
  const someday = task({ properties: { someday: true } });
  const completed = task({ status: "completed", properties: { when: TODAY, inbox: true } });
  const membership = (entity) => ["Inbox", "Today", "Overdue", "Upcoming", "Anytime", "Someday", "Completed"]
    .filter((view) => taskMatchesView(entity, view, TODAY));

  assert.deepEqual(membership(inbox), ["Inbox"]);
  assert.deepEqual(membership(flaggedToday), ["Today"]);
  assert.deepEqual(membership(dueToday), ["Today"]);
  assert.deepEqual(membership(overdue), ["Today", "Overdue"]);
  assert.deepEqual(membership(upcoming), ["Upcoming"]);
  assert.deepEqual(membership(anytime), ["Anytime"]);
  assert.deepEqual(membership(someday), ["Someday"]);
  assert.deepEqual(membership(completed), ["Completed"]);
});

test("a completed task never appears in an open view and unknown views list open tasks", () => {
  assert.equal(taskMatchesView(task({ status: "completed" }), "Today", TODAY), false);
  assert.equal(taskMatchesView(task(), "Projects", TODAY), true);
  assert.equal(taskMatchesView(task({ status: "archived" }), "Projects", TODAY), false);
});

test("manual order prefers the workspace-scoped value, then the scope, then creation time", () => {
  assert.equal(manualOrder(task({ properties: { manualOrders: { "personal:task:Today": 3, "task:Today": 9 } } }), "task:Today"), 3);
  assert.equal(manualOrder(task({ properties: { manualOrders: { "task:Today": 9 } } }), "task:Today"), 9);
  assert.equal(manualOrder(task({ properties: { manualOrders: { "shared:task:Today": 1 } } }), "task:Today"), 1000);
  assert.equal(manualOrder(task({ properties: { manualOrder: 4 } })), 4);
  assert.equal(manualOrder(task()), 1000);
  assert.equal(manualOrder(task({ properties: { manualOrders: { "personal:task:all": 2 } } })), 2);
});

test("manual sort is stable across equal positions", () => {
  const a = task({ id: "a", createdAt: 5, properties: { manualOrder: 1 } });
  const b = task({ id: "b", createdAt: 5, properties: { manualOrder: 1 } });
  const c = task({ id: "c", createdAt: 1, properties: { manualOrder: 1 } });
  const d = task({ id: "d", createdAt: 9, properties: { manualOrder: 0 } });
  assert.deepEqual([b, a, c, d].sort(byManualOrder()).map((entity) => entity.id), ["d", "c", "a", "b"]);
});

test("due tone marks overdue before soon and ignores closed or non-task records", () => {
  assert.equal(taskDueTone(task({ properties: { when: "2026-10-06" } }), TODAY, NOW), "dueOverdue");
  assert.equal(taskDueTone(task({ properties: { when: "2026-10-20", deadline: "2026-10-01" } }), TODAY, NOW), "dueOverdue");
  assert.equal(taskDueTone(task({ properties: { when: TODAY } }), TODAY, NOW), "dueSoon");
  assert.equal(taskDueTone(task({ properties: { deadline: "2026-10-08" } }), TODAY, NOW), "dueSoon");
  assert.equal(taskDueTone(task({ properties: { when: "2026-10-09" } }), TODAY, NOW), "");
  assert.equal(taskDueTone(task({ properties: { when: "soon" } }), TODAY, NOW), "");
  assert.equal(taskDueTone(task({ status: "completed", properties: { when: "2026-10-01" } }), TODAY, NOW), "");
  assert.equal(taskDueTone(task({ type: "project", status: "open", properties: { deadline: "2026-10-01" } }), TODAY, NOW), "");
});

test("quick capture parses Czech relative days and priority tokens", () => {
  assert.deepEqual(parseCaptureText("Zavolat Petrovi zítra !", TODAY, NOW), { title: "Zavolat Petrovi", when: "2026-10-08", priority: "high" });
  assert.deepEqual(parseCaptureText("dnes poslat fakturu #medium", TODAY, NOW), { title: "poslat fakturu", when: TODAY, priority: "medium" });
  assert.deepEqual(parseCaptureText("  Projít   poznámky #low ", TODAY, NOW), { title: "Projít poznámky", when: "", priority: "low" });
  assert.deepEqual(parseCaptureText("Koupit lístky #HIGH", TODAY, NOW), { title: "Koupit lístky", when: "", priority: "high" });
});

test("quick capture leaves words that merely contain a token untouched", () => {
  assert.deepEqual(parseCaptureText("Plán na pozítra", TODAY, NOW), { title: "Plán na pozítra", when: "", priority: "none" });
  assert.deepEqual(parseCaptureText("Hotovo!", TODAY, NOW), { title: "Hotovo!", when: "", priority: "none" });
});

test("quick capture parses a trailing Czech date and rolls a past day into next year", () => {
  assert.deepEqual(parseCaptureText("Report 15.10.", TODAY, NOW), { title: "Report", when: "2026-10-15", priority: "none" });
  assert.deepEqual(parseCaptureText("Report 7.10", TODAY, NOW), { title: "Report", when: TODAY, priority: "none" });
  assert.deepEqual(parseCaptureText("Report 1.2.", TODAY, NOW), { title: "Report", when: "2027-02-01", priority: "none" });
  assert.deepEqual(parseCaptureText("Report 1.2.2026", TODAY, NOW), { title: "Report", when: "2026-02-01", priority: "none" });
});

test("quick capture keeps an impossible date as literal text", () => {
  assert.deepEqual(parseCaptureText("Report 31.2.", TODAY, NOW), { title: "Report 31.2.", when: "", priority: "none" });
});

test("a task added in Today gets today's date as well as the flag", () => {
  const options = { view: "Today", today: TODAY, hasProject: false };
  assert.deepEqual(newTaskPlacement("", {}, options), { inbox: false, today: true, when: TODAY });
  const created = task({ properties: newTaskPlacement("", {}, options) });
  assert.deepEqual(["Today", "Anytime", "Overdue"].filter((view) => taskMatchesView(created, view, TODAY)), ["Today"]);
  assert.deepEqual(["Today", "Anytime", "Overdue"].filter((view) => taskMatchesView(created, view, "2026-10-08")), ["Today", "Overdue"]);
});

test("new task placement follows a typed date, then explicit values, then the view", () => {
  assert.deepEqual(newTaskPlacement("2026-10-20", { today: true, inbox: true }, { view: "Today", today: TODAY, hasProject: false }), { inbox: false, today: false, when: "2026-10-20" });
  assert.deepEqual(newTaskPlacement(TODAY, {}, { view: "Inbox", today: TODAY, hasProject: false }), { inbox: false, today: true, when: TODAY });
  assert.deepEqual(newTaskPlacement("", {}, { view: "Inbox", today: TODAY, hasProject: false }), { inbox: true, today: false });
  assert.deepEqual(newTaskPlacement("", {}, { view: "Inbox", today: TODAY, hasProject: true }), { inbox: false, today: false });
  assert.deepEqual(newTaskPlacement("", {}, { view: "Anytime", today: TODAY, hasProject: false }), { inbox: false, today: false });
  assert.deepEqual(newTaskPlacement("", { today: false, inbox: false }, { view: "Today", today: TODAY, hasProject: false }), { inbox: false, today: false });
  assert.deepEqual(newTaskPlacement("", { today: true, when: TODAY }, { view: "Home", today: TODAY, hasProject: false }), { inbox: false, today: true });
});

test("a cleared date is no date: the task is neither Today nor Overdue", () => {
  const views = ["Inbox", "Today", "Overdue", "Upcoming", "Anytime", "Someday"];
  const membership = (properties) => views.filter((view) => taskMatchesView(task({ properties }), view, TODAY));
  assert.deepEqual(membership({ when: "", today: false, inbox: false, someday: false }), ["Anytime"]);
  assert.deepEqual(membership({ when: "", today: false, inbox: true, someday: false }), ["Inbox"]);
  assert.deepEqual(membership({ when: "", today: false, inbox: false, someday: true }), ["Someday"]);
  assert.deepEqual(membership({ when: "", today: true }), ["Today"]);
});

test("a date written the Czech way with spaces is read from the end of the text", () => {
  const parse = (text) => parseCaptureText(text, TODAY, NOW);
  assert.deepEqual(parse("Zaplatit pojistku 25. 10."), { title: "Zaplatit pojistku", when: "2026-10-25", priority: "none" });
  assert.deepEqual(parse("Zaplatit pojistku 25. 10. 2027"), { title: "Zaplatit pojistku", when: "2027-10-25", priority: "none" });
  assert.deepEqual(parse("Zaplatit pojistku 25. 10.2027"), { title: "Zaplatit pojistku", when: "2027-10-25", priority: "none" });
  assert.deepEqual(parse("Zaplatit pojistku 5. 1."), { title: "Zaplatit pojistku", when: "2027-01-05", priority: "none" });
  // The forms without spaces keep working.
  assert.deepEqual(parse("Zaplatit pojistku 25.10"), { title: "Zaplatit pojistku", when: "2026-10-25", priority: "none" });
  assert.deepEqual(parse("Zaplatit pojistku 25.10.2026."), { title: "Zaplatit pojistku", when: "2026-10-25", priority: "none" });
});

test("a priority mark may follow the date", () => {
  assert.deepEqual(parseCaptureText("Zaplatit pojistku 25. 10. !", TODAY, NOW), { title: "Zaplatit pojistku", when: "2026-10-25", priority: "high" });
  assert.deepEqual(parseCaptureText("Zaplatit pojistku 25.10. #low", TODAY, NOW), { title: "Zaplatit pojistku", when: "2026-10-25", priority: "low" });
});

test("numbers that are not a date stay in the title", () => {
  const parse = (text) => parseCaptureText(text, TODAY, NOW);
  assert.deepEqual(parse("Přečíst kapitolu 2. 5"), { title: "Přečíst kapitolu 2. 5", when: "", priority: "none" });
  assert.deepEqual(parse("Objednat 31. 2."), { title: "Objednat 31. 2.", when: "", priority: "none" });
  assert.deepEqual(parse("Verze 25. 10. je hotová"), { title: "Verze 25. 10. je hotová", when: "", priority: "none" });
  assert.deepEqual(parse("Zavolat na 3. patro"), { title: "Zavolat na 3. patro", when: "", priority: "none" });
});

test("a task added in Someday or Upcoming stays in the view it was typed into", () => {
  const place = (view, properties = {}, parsedWhen = "") => newTaskPlacement(parsedWhen, properties, { view, today: TODAY, hasProject: false });
  const viewsOf = (properties) => ["Inbox", "Today", "Upcoming", "Anytime", "Someday"].filter((view) => taskMatchesView(task({ properties }), view, TODAY));
  assert.deepEqual(place("Someday"), { inbox: false, today: false, someday: true });
  assert.deepEqual(viewsOf(place("Someday")), ["Someday"]);
  assert.deepEqual(place("Upcoming"), { inbox: false, today: false, when: "2026-10-08" });
  assert.deepEqual(viewsOf(place("Upcoming")), ["Upcoming"]);
  // A typed date or an explicit choice still wins over the view.
  assert.deepEqual(place("Someday", {}, "2026-10-20"), { inbox: false, today: false, when: "2026-10-20" });
  assert.deepEqual(place("Upcoming", { when: "2026-11-01" }), { inbox: false, today: false });
  assert.deepEqual(place("Someday", { someday: false }), { inbox: false, today: false });
  assert.deepEqual(place("Upcoming", { today: true }), { inbox: false, today: true, when: TODAY });
  // The last day of a month rolls over correctly.
  assert.deepEqual(newTaskPlacement("", {}, { view: "Upcoming", today: "2026-10-31", hasProject: false }), { inbox: false, today: false, when: "2026-11-01" });
});
