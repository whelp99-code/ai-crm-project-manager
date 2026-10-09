# Self-entry screen design contract

## 0. Reference and scope

Operational extension of the existing app, not a redesign. Reference: `app/layout.tsx` and its reusable shell, panel, error and typography rules. Preserve its Korean customer-work operating-room identity. No stock images, animated atmosphere, new font download or production instrumentation.

## 1. Tokens

- Background #f4f7f5; panel #ffffff; text #17221d; secondary #526159.
- Brand/action #176b47; shell #153e2d; boundary #ccd7d1.
- Error #a53b32; focus #f0a43a.
- Existing system/Inter/Pretendard font stack; body 16px, secondary 14px, page heading 28–42px.
- Spacing 4, 8, 12, 16, 24, 32px. Form maximum width 480px, full available width on mobile.
- Panel corner radius 10px, input/action radius 6px; restrained borders with no extra elevation.

## 2. Content and responsive layout

One left-aligned page heading, purpose text, two-step progress text and a single centered form panel. Explicit owner-only instruction. Do not show operating scope values or credentials.
At 390px, every control fits the viewport with at least 16px side space. At 1440px, keep the form compact rather than stretching fields.

## 3. States and motion

Password, OTP, submitting, denied, locked, expired, configuration-required and authenticated.
Password stage transitions locally without claiming authentication. Authentication occurs only after the single existing password+TOTP request.
No animation; native hover/focus states. Disable controls during submission. Clear sensitive inputs on cancellation/failure/completion and never persist them to browser storage.

## 4. Accessibility

Explicit labels and autocomplete attributes. Password: type=password/current-password; OTP: masked, numeric, one-time-code, six digits.
Visible keyboard focus, touch targets at least 44px, error/status announcements through role=alert/status. Move focus to the OTP field after transitioning.
Configuration-required state lists key names, never configured values, and provides no enabled login submission.

## 5. Reusable primitives and state harness

- Existing shell/topbar/panel/lead/meta primitives from RootLayout.
- Scoped self-entry field, primary action, secondary back action, status/error panel and step indicator.
- The login/OTP/error/configured-denial screenshots are the state harness for these primitives; capture mobile and desktop after implementation.

## 6. Security and accepted boundaries

All screenshots and automated interactions use explicit synthetic test values only. Actual owner password/TOTP are entered only by the owner after operating decisions/pre-enrollment are verified.
Unknown company/workspace/origin/endpoint/session-policy inputs remain OWNER_DECISION_REQUIRED. Successful local fixtures do not constitute production readiness or a deployment.
