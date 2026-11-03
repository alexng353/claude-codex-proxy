import { afterEach, describe, expect, test } from "bun:test";
import { parseStart } from "../src/gym-client";
import { emptyState, inTransit, localTime, outstanding, setZoneHistory, zoneAt, type GateState, type ZoneChange } from "../src/hygiene";

// Vancouver is UTC-7 all year from Nov 2026; Jakarta is UTC+7. All times below are UTC.
const Z = (iso: string) => Date.parse(iso);
const VAN = "America/Vancouver";
const JKT = "Asia/Jakarta";

/** Every morning item on (teeth, weigh-in, creatine, walk); nothing filled. */
function state(): GateState {
  const s = emptyState("2026-10-01T12:00:00Z");
  s.weighInStartsAt = "2026-10-01T12:00:00Z";
  s.creatineStartsAt = "2026-10-01T12:00:00Z";
  s.walkStartsAt = "2026-10-01T12:00:00Z";
  return s;
}
const slots = (s: GateState, now: number) => outstanding(s, now).map((r) => r.slot).sort();

// Last Vancouver report Nov 13 20:00 PST; the phone reports Jakarta on landing, Nov 15 08:00 WIB.
const there: ZoneChange[] = [
  { zone: VAN, from: "2026-11-01T12:00:00Z", seenAt: "2026-11-14T03:00:00Z" },
  { zone: JKT, from: "2026-11-15T01:00:00Z", seenAt: "2026-12-03T03:00:00Z" },
];
// Back: last Jakarta report Dec 3 10:00 WIB, Vancouver reported on landing Dec 3 20:00 PST.
const back: ZoneChange[] = [...there, { zone: VAN, from: "2026-12-04T04:00:00Z", seenAt: "2026-12-04T04:00:00Z" }];

afterEach(() => setZoneHistory(undefined));

describe("travel: the gate's day follows the phone's zone", () => {
  test("Vancouver unchanged: a Vancouver-only history is the same as none", () => {
    const at = Z("2026-11-10T14:00:00Z"); // Nov 10 07:00 PST
    const before = slots(state(), at);
    setZoneHistory([{ zone: VAN, from: "2026-11-01T12:00:00Z", seenAt: "2026-11-10T13:00:00Z" }]);
    expect(slots(state(), at)).toEqual(before);
    expect(before).toEqual([
      "2026-11-09/night-teeth",
      "2026-11-09/shower",
      "2026-11-10/morning-creatine",
      "2026-11-10/morning-teeth",
      "2026-11-10/morning-walk",
      "2026-11-10/morning-weight",
    ]);
  });

  test("the flight there: nothing locks in transit, Jakarta days after", () => {
    setZoneHistory(there);
    expect(zoneAt(Z("2026-11-15T03:00:00Z"))).toBe(JKT);
    expect(localTime(Z("2026-11-15T03:00:00Z"))).toEqual({ day: "2026-11-15", minutes: 10 * 60 });
    // Landed, Nov 15 10:00 WIB, and Nov 16 06:00 WIB (still within 24 h of the report): no slot locks.
    expect(slots(state(), Z("2026-11-15T03:00:00Z"))).toEqual([]);
    expect(slots(state(), Z("2026-11-15T23:00:00Z"))).toEqual([]);
    // Nov 17 06:00 WIB: Jakarta's Nov 16 evening and Nov 17 morning, creatine and walk included.
    expect(slots(state(), Z("2026-11-16T23:00:00Z"))).toEqual([
      "2026-11-16/night-teeth",
      "2026-11-16/shower",
      "2026-11-17/morning-creatine",
      "2026-11-17/morning-teeth",
      "2026-11-17/morning-walk",
      "2026-11-17/morning-weight",
    ]);
    // The morning arms at 05:00 WIB, not 05:00 Vancouver (20:00 WIB).
    expect(slots(state(), Z("2026-11-16T21:59:00Z")).filter((x) => x.includes("morning"))).toEqual([]);
  });

  test("a day in transit with no report locks live, and is cleared once the phone reports on landing", () => {
    // Nov 14 06:00 PST, on the plane: the gate only knows Vancouver.
    setZoneHistory(there.slice(0, 1));
    const midFlight = Z("2026-11-14T13:00:00Z");
    expect(slots(state(), midFlight)).toContain("2026-11-14/morning-walk");
    expect(slots(state(), midFlight)).toContain("2026-11-14/morning-creatine");
    expect(slots(state(), midFlight)).toContain("2026-11-14/morning-weight");
    // After the landing report, the slots of the silent flight no longer lock.
    setZoneHistory(there);
    expect(inTransit(Z("2026-11-14T12:00:00Z"))).toBe(true);
    expect(slots(state(), Z("2026-11-15T01:30:00Z"))).toEqual([]);
  });

  test("the flight back: nothing locks in transit, Vancouver days after, no slot counted twice", () => {
    setZoneHistory(back);
    // Dec 4 06:00 PST, the first morning home: free.
    expect(slots(state(), Z("2026-12-04T14:00:00Z"))).toEqual([]);
    // Dec 5 06:00 PST: Vancouver's Dec 4 evening and Dec 5 morning.
    expect(slots(state(), Z("2026-12-05T14:00:00Z"))).toEqual([
      "2026-12-04/night-teeth",
      "2026-12-04/shower",
      "2026-12-05/morning-creatine",
      "2026-12-05/morning-teeth",
      "2026-12-05/morning-walk",
      "2026-12-05/morning-weight",
    ]);
    // Dec 3 happens twice (Jakarta, then Vancouver): a slot filled in Jakarta stays filled.
    const s = state();
    s.filled["2026-12-03/morning-teeth"] = "2026-12-02T23:00:00Z";
    expect(slots(s, Z("2026-12-04T05:00:00Z"))).not.toContain("2026-12-03/morning-teeth");
  });

  test("flipping the phone's zone again within 7 days grants no second travel day", () => {
    setZoneHistory([
      { zone: VAN, from: "2026-11-01T12:00:00Z", seenAt: "2026-11-03T11:00:00Z" },
      { zone: "Asia/Tokyo", from: "2026-11-03T12:00:00Z", seenAt: "2026-11-05T11:00:00Z" },
      { zone: VAN, from: "2026-11-05T12:00:00Z", seenAt: "2026-11-05T12:00:00Z" },
    ]);
    expect(inTransit(Z("2026-11-04T00:00:00Z"))).toBe(true);
    // The Nov 5 night slot arms at Nov 6 00:00 PST, within 24 h of the second flip: it still locks.
    expect(inTransit(Z("2026-11-06T07:00:00Z"))).toBe(false);
    expect(slots(state(), Z("2026-11-06T14:00:00Z"))).toContain("2026-11-05/night-teeth");
  });

  test("a long silence before a change forgives at most 48 h of it", () => {
    setZoneHistory([
      { zone: VAN, from: "2026-11-01T12:00:00Z", seenAt: "2026-11-02T12:00:00Z" },
      { zone: JKT, from: "2026-11-10T00:00:00Z", seenAt: "2026-11-10T00:00:00Z" },
    ]);
    expect(inTransit(Z("2026-11-08T01:00:00Z"))).toBe(true);
    expect(inTransit(Z("2026-11-07T23:00:00Z"))).toBe(false);
  });

  test("plan times typed as wall times are read in the phone's zone", () => {
    expect(parseStart("2026-11-16 18:00")).toBe("2026-11-17T01:00:00.000Z");
    setZoneHistory(there);
    expect(parseStart("2026-11-16 18:00")).toBe("2026-11-16T11:00:00.000Z");
  });
});
