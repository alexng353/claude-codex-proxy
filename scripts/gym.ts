#!/usr/bin/env bun
/**
 * Gym plans on the hygiene gate (src/gym.ts). Times are wall times in the
 * phone's current zone ("2026-11-04 18:00", read by the gate) or ISO with an offset.
 *
 *   bun scripts/gym.ts status
 *   bun scripts/gym.ts add "2026-11-04 18:00" [--grace 30] [--note TEXT] [--by NAME]
 *   bun scripts/gym.ts move ID "2026-11-04 19:00" [--note TEXT] [--by NAME]
 *   bun scripts/gym.ts cancel ID [--note TEXT] [--by NAME]
 *   bun scripts/gym.ts grace MINUTES        (default grace for new plans)
 *   bun scripts/gym.ts sync                 (read Uplifting now)
 *   bun scripts/gym.ts credit --start T --end T --reason TEXT --by NAME [--workout ID] [--sets N]
 *                                           (hand credit for a session verified outside the gate)
 *   bun scripts/gym.ts pause --from 2026-11-14 --to 2026-12-03 --reason TEXT [--by NAME]
 *                                           (travel pause; plain dates are whole Vancouver days, to inclusive)
 *   bun scripts/gym.ts pause-end ID [--by NAME]
 *   bun scripts/gym.ts proof checkins|workout-tag [--tag TEXT]
 *                                           (workout-tag: a synced workout tagged at the gym counts; for
 *                                            Uplifting builds that send no check-ins)
 */
import { describeReport, gymCall, startArg } from "../src/gym-client";
import { addDays } from "../src/hygiene";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function flags(args: string[]): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) named[arg.slice(2)] = args[++i] ?? "";
    else positional.push(arg);
  }
  return { positional, named };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, named } = flags(rest);
  const by = named.by || process.env.GYM_BY || "cli";
  const note = named.note;
  const show = (r: { status: number; body: any }) => {
    if (r.status >= 400 || r.body?.ok === false) fail(r.body?.error ?? `failed (${r.status})`);
    console.log(r.body?.message ?? describeReport(r.body));
  };
  switch (command) {
    case "status":
      return show(await gymCall(""));
    case "sync":
      return show(await gymCall("/sync", {}));
    case "add": {
      const start = startArg(positional[0] ?? "") ?? fail('add needs a start: "YYYY-MM-DD HH:MM" (phone zone) or ISO with an offset');
      if (named.grace !== undefined && !/^\d+$/.test(named.grace)) fail("--grace must be a whole number of minutes");
      return show(await gymCall("/plans", { start, by, note, ...(named.grace !== undefined ? { grace_min: Number(named.grace) } : {}) }));
    }
    case "move": {
      const [id, when] = positional;
      if (!id) fail("move needs a plan id");
      const start = startArg(when ?? "") ?? fail("move needs a new start");
      return show(await gymCall(`/plans/${encodeURIComponent(id)}/move`, { start, by, note }));
    }
    case "cancel":
      if (!positional[0]) fail("cancel needs a plan id");
      return show(await gymCall(`/plans/${encodeURIComponent(positional[0])}/cancel`, { by, note }));
    case "grace": {
      if (!/^\d+$/.test(positional[0] ?? "")) fail("grace needs a whole number of minutes");
      const r = await gymCall("/settings", { grace_min: Number(positional[0]) });
      if (r.status >= 400) fail(r.body?.error ?? `failed (${r.status})`);
      return console.log(`default grace is now ${r.body.settings.graceMin} min (${r.body.note})`);
    }
    case "credit": {
      const start = startArg(named.start ?? "") ?? fail("credit needs --start");
      const end = startArg(named.end ?? "") ?? fail("credit needs --end");
      if (!named.reason || !named.by) fail("credit needs --reason and --by");
      const r = await gymCall("/sessions/credit", {
        start,
        end,
        reason: named.reason,
        by: named.by,
        ...(named.workout ? { workout_id: named.workout } : {}),
        ...(named.sets ? { sets: Number(named.sets) } : {}),
      });
      if (r.status >= 400) fail(r.body?.error ?? `failed (${r.status})`);
      return console.log(`credited ${r.body.session.id}: ${r.body.session.start} to ${r.body.session.end}`);
    }
    case "pause": {
      const from = startArg(DATE.test(named.from ?? "") ? `${named.from} 00:00` : (named.from ?? "")) ?? fail("pause needs --from (YYYY-MM-DD or a time)");
      const to = startArg(DATE.test(named.to ?? "") ? `${addDays(named.to!, 1)} 00:00` : (named.to ?? "")) ?? fail("pause needs --to (YYYY-MM-DD, inclusive, or a time)");
      if (!named.reason) fail("pause needs --reason");
      return show(await gymCall("/pauses", { from, to, reason: named.reason, by }));
    }
    case "pause-end":
      if (!positional[0]) fail("pause-end needs a pause id");
      return show(await gymCall(`/pauses/${encodeURIComponent(positional[0])}/end`, { by }));
    case "proof": {
      const mode = positional[0];
      if (mode !== "checkins" && mode !== "workout-tag") fail("proof needs checkins or workout-tag");
      const r = await gymCall("/settings", { proof: mode, ...(named.tag ? { tag_pattern: named.tag } : {}) });
      if (r.status >= 400) fail(r.body?.error ?? `failed (${r.status})`);
      return console.log(`proof is now ${r.body.settings.proof} (tag must contain "${r.body.settings.tagPattern}")`);
    }
    default:
      fail("usage: gym.ts status | add WHEN | move ID WHEN | cancel ID | grace MIN | sync | credit --start --end --reason --by");
  }
}

await main();
