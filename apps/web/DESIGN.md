# Core5 owner lists — design contract

Existing operational surface. Do not invent a new brand. Tokens below are the ones already shipping in `app/layout.tsx`, extended only for phone list density.

## Tokens

- Ink `#17221d` on `#f4f7f5`. Surface `#fff`. Line `#ccd7d1` / row `#d9e1dd`.
- Forest bar `#153e2d`, gold rule `#d7a13f`, link `#176b47`, muted `#46564d`.
- Focus ring `#f0a43a`, 3px, offset 3px. Only coloured edge allowed.
- Type: 16px name (weight 680), 13px secondary, 22px page title on phone / 28px from 900px. Tabular numerals for money.
- Space: 4 / 8 / 12 / 16. Row min-height 48px. Touch targets min 44px.
- Radius 10px panels, 999px chips. No accent side-borders. No new motion.

## Owner vs dev

Phone and desktop owner nav is one line: 계정 · 프로젝트 · 재무. Dev routes stay reachable under 개발 and are not deleted.

## Lists

One record, one row: name (max two lines) plus one secondary line of text chips. Money right-aligned with 원. Search filters the visible name only; server counts stay on the page.
