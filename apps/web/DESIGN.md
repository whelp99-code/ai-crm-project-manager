# CRM owner review design

## 1. Atmosphere and identity
Extend the existing Korean operating room, not a new dashboard: green header,
gold focus, pale background and white bordered review panels. Source evidence
and one owner's decision are the visual priority.

## 2. Color
Existing layout tokens: background #f4f7f5, surface #fff, ink #17221d,
muted #526159, border #ccd7d1, green #176b47, header #153e2d,
focus #f0a43a, error #a53b32. Scope these as CSS custom properties in
the candidate review module; preserve shared shell appearance.

## 3. Typography
Inherit Inter/Pretendard/system sans. Existing body16px/1.65, metadata14px,
card heading20px, page heading clamp28–42px. No remote font/assets.

## 4. Spacing and layout
Reuse max1160px shell with16px mobile gutters. Single document scroll.
Review queue: cards, evidence metadata, labeled controls, decision history.
Use8/12/16/24px spacing,10px panel radius, min44px controls. At390px
controls stack and long source locators wrap; no horizontal scroll.

## 5. Components
Reuse shell, panel, stack, status-row, status and meta classes.
Candidate card has heading, source description, evidence link, received/
record date, decision controls and disclosure history. Controls have
default/hover/press/focus/disabled states; pending work disables controls
immediately, errors are adjacent. Empty, loading and expired-session panels
are explicit. Confirm and discard are peer44px controls. Undo remains
visible for a current non-undone review; no destructive delete.

## 6. Motion and interaction
No decorative animation; retain instant native selection and clear disabled
pending state. Subtle100ms background transition only, reduced-motion
disables transition. Keyboard focus uses existing gold outline.

## 7. Depth and surface
Borders-only, matching existing layout. White panels on pale background,
10px card and6px control radii; no new shadows or decorative gradients.

## 8. Accessibility and accepted constraints
Korean labels for every input/select, semantic buttons/links, polite result
announcements and alert errors. No color-only statuses. Disclosure audit
history, safe HTTP(S) evidence links with noreferrer. Existing shell is
light-only; user scope requires1440/390 captures, not a theme redesign.
No dev dependencies or broad audit tooling are added under the explicit
related-check-only instruction. Review session import consumes an existing
proof; passwords/OTP and production credentials are never collected here.
