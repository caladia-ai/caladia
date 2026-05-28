import { describe, it, expect } from 'vitest';
import type { Resource } from '@procsim/file-format';
import { computeConflictedNodes } from './conflicts.js';
import type { ResourceTimelineEntry } from './types.js';

/**
 * Phase 50 Slice 19 — audit row I-2.
 *
 * `computeConflictedNodes` previously bucketed timeline entries into
 * calendar-day slots via `Math.floor((date.getTime() - projectStartMs)
 * / 86_400_000)`. The fixed 24h divisor ignores DST: around a US
 * spring-forward, Sunday→Monday in local time is only 23h in UTC ms,
 * so events in the first hour after midnight of any day following a
 * spring-forward Sunday got wrongly bucketed into the previous calendar
 * day. The fix mirrors `prepared.ts`'s `dayOf`: take local midnight of
 * the input and divide+round.
 *
 * The full test suite runs with `TZ=America/New_York` pinned (see
 * `ARCHITECTURE.md` → Engine local-time anchoring + the root
 * `package.json` `test` script + the CI workflow). The boundary day
 * here — Sun Mar 8, 2026 — is exactly when US DST starts.
 */

const RESOURCE: Resource = {
  id: 'r1',
  name: 'R1',
  capacity: 1,
  calendarId: 'cal-default',
};

describe('computeConflictedNodes — DST safety (audit I-2)', () => {
  it('does not falsely flag two assignments that share a day only under broken bucketing', () => {
    // Project starts Saturday March 7, 2026. US DST 2026 starts at
    // 02:00 EST on Sunday Mar 8 (clocks jump to 03:00 EDT), so:
    //   - Day 0: Sat Mar 7  (24h UTC — DST hasn't happened yet)
    //   - Day 1: Sun Mar 8  (23h UTC — DST shift eats one UTC hour)
    //   - Day 2: Mon Mar 9  (24h UTC again)
    // Pre-fix, an event at Mon Mar 9 00:30 had ms-delta = 47.5h →
    // floor(47.5/24) = 1, which mis-bucketed it into Sunday. Post-fix,
    // the same event correctly buckets into Monday (day 2).
    //
    // Test setup: assignment X spans Sat + Sun (days {0, 1}), Y spans
    // Mon entirely (day {2} post-fix; days {1, 2} pre-fix). Resource
    // capacity 1.
    //   - Pre-fix:  X∩Y = {1} ⇒ conflict on day 1
    //   - Post-fix: X∩Y = ∅   ⇒ no conflict
    const startDate = '2026-03-07';
    const timeline: ResourceTimelineEntry[] = [
      {
        resourceId: 'r1',
        nodeId: 'x',
        iteration: 0,
        start: new Date(2026, 2, 7, 9, 0), // Sat Mar 7 09:00 local
        end: new Date(2026, 2, 8, 17, 0), // Sun Mar 8 17:00 local
        count: 1,
      },
      {
        resourceId: 'r1',
        nodeId: 'y',
        iteration: 0,
        start: new Date(2026, 2, 9, 0, 30), // Mon Mar 9 00:30 local
        end: new Date(2026, 2, 9, 23, 0), // Mon Mar 9 23:00 local
        count: 1,
      },
    ];

    const conflicts = computeConflictedNodes(timeline, [RESOURCE], startDate, []);
    expect(conflicts).toEqual({});
  });

  it('still flags two assignments that actually overlap on the DST day', () => {
    // Sanity guard for the negative test above: when X and Y both
    // really do touch Sunday (the DST day), the conflict is detected.
    const startDate = '2026-03-07';
    const timeline: ResourceTimelineEntry[] = [
      {
        resourceId: 'r1',
        nodeId: 'x',
        iteration: 0,
        start: new Date(2026, 2, 8, 9, 0), // Sun Mar 8 09:00
        end: new Date(2026, 2, 8, 17, 0), // Sun Mar 8 17:00
        count: 1,
      },
      {
        resourceId: 'r1',
        nodeId: 'y',
        iteration: 0,
        start: new Date(2026, 2, 8, 12, 0), // Sun Mar 8 12:00
        end: new Date(2026, 2, 8, 20, 0), // Sun Mar 8 20:00
        count: 1,
      },
    ];

    const conflicts = computeConflictedNodes(timeline, [RESOURCE], startDate, []);
    expect(conflicts.x).toEqual([{ resourceId: 'r1', overCapacityDayCount: 1 }]);
    expect(conflicts.y).toEqual([{ resourceId: 'r1', overCapacityDayCount: 1 }]);
  });
});
