# open-reception Design Kit

Tracking: #1142  
Default visual migration: #1143  
Foundation contract: `20m61/cinc-foundation-bootstrap#18`

## Status

This repository has a mature UI quality system, but two different kinds of design truth must not be conflated:

1. **As-Is implementation truth** — current tokens and reviewed VRT baselines.
2. **To-Be product direction** — the default UI should be light, white, clean, spacious and restrained rather than dark-by-default.

The current `src/app/globals.css` still identifies itself as `premium dark`. That file remains the implementation source until the migration is reviewed, but it is **not** promoted here as the final visual direction. #1143 owns that migration.

## Product identity

### Canonical product icon

`src/app/icon.tsx` is an approved product PWA/browser icon source from completed owner-authored issue #331.

It is explicitly independent from tenant branding and is reused by:

- the runtime browser/PWA icon;
- the Web App Manifest;
- the Apple home-screen icon through `renderMark`.

Do not redraw this icon merely because the visual theme changes.

### Product logo / wordmark

No standalone owner-approved product logo/wordmark was located during the Design Kit audit.

Therefore:

- `primaryLogo` is `pending`;
- the textual product name `open-reception` is not silently promoted to a graphic logo asset;
- tenant logos are not product logos;
- a generated mockup may propose a logo but cannot make it canonical.

## Tenant branding boundary

Tenant branding already supports company identity and accent colour. It is separate from product identity.

A tenant may influence the intended allowlisted branding layer, but must not erase or repurpose:

- danger;
- warning;
- success;
- accessibility focus;
- platform break-glass / caution semantics;
- product operational state meaning.

The product icon remains product-owned regardless of tenant branding.

## Tokens

Current executable tokens live in `src/app/globals.css`.

The file already contains a strong semantic structure:

- background/surface/text;
- tenant-derived accent;
- danger/warning/success;
- platform operational semantics;
- touch/spacing/radius;
- z-index layer contracts;
- motion;
- typography and accessibility scaling.

That structure should be preserved through #1143 even when primitive values move from dark to light.

## Visual direction

### To-Be default

The default product UI should be:

- white/light based;
- clear and calm;
- spacious;
- visually organized;
- minimally decorative;
- easy to operate while standing at an iPad;
- suitable for a reception desk rather than a gaming/dashboard aesthetic.

Dark/glass/glow treatments must not remain the default merely because historical VRT already captures them.

### Migration rule

Do not update screenshots first and declare the result correct.

The required sequence is:

```
approved light-default intent
      ↓
semantic token mapping
      ↓
kiosk/admin implementation
      ↓
a11y + behavior checks
      ↓
implementation screenshots
      ↓
human visual review
      ↓
explicit VRT baseline update
```

## Existing quality evidence

The repository already has unusually strong evidence:

- `tests/e2e/kiosk-vrt-a11y.spec.ts`
  - 1080×810 landscape;
  - major kiosk states;
  - axe critical/serious 0;
  - strict visual diff.
- `tests/e2e/kiosk-screenshot.spec.ts`
  - 810×1080 portrait;
  - 1080×810 landscape;
  - 1920×1080 large display.
- `tests/e2e/admin-vrt-a11y.spec.ts`
  - 1440×900 desktop admin.
- `playwright.config.ts`
  - refuses silent missing-baseline generation;
  - keeps reviewed baseline naming stable across project refactors.

Design Kit adoption should preserve these gates, not replace them.

## Agent rules

Before a UI/brand change:

1. read `brand.manifest.json`;
2. do not invent a product logo;
3. do not redraw the approved product icon without a new approval record;
4. preserve tenant/product identity separation;
5. treat current dark VRT as As-Is evidence, not a permanent visual mandate;
6. use #1143 for the light-default migration;
7. never make a baseline update the only evidence that a redesign is correct.
