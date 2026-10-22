# Canonical screen evidence

The executable VRT specs remain the detailed source of truth. This document gives Design Kit consumers one stable map.

## Primary kiosk viewport

**1080×810 — iPad landscape**

This is the primary reception design-review viewport.

Existing evidence:
- `tests/e2e/kiosk-vrt-a11y.spec.ts`
- `tests/e2e/kiosk-screenshot.spec.ts`

Canonical states include:

1. idle / signage-ready waiting state
2. reception start
3. purpose selection
4. staff / department target selection
5. confirmation
6. calling / handoff
7. result / completion
8. operational exception states where deterministic capture is safe

Dynamic/avatar/clock content may be masked when it would make the screenshot non-deterministic. Masking must not hide the layout region under review.

## Secondary kiosk viewports

- 810×1080 — iPad portrait fallback
- 1920×1080 — large display/signage

## Admin viewport

**1440×900 — desktop**

Existing evidence:
- `tests/e2e/admin-vrt-a11y.spec.ts`

Use deterministic settings screens rather than dashboards containing time-dependent health/activity values.

## Baseline governance

- missing baselines must fail rather than auto-approve;
- intentional visual changes use explicit `--update-snapshots`;
- review the diff before committing;
- current baselines prove the current implementation, not the correctness of the future light-default direction;
- #1143 must deliberately replace affected dark baselines only after implementation review.
