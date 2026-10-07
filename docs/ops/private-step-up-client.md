# Private input client: source-only preparation

`apps/api/src/private-step-up-client.ts` is a draft library, not an installed
login screen or operating client. It reads API key/password/OTP directly from
a private TTY with echo disabled. There is no credential argv/env/file input,
shell launch, cookie jar, persistent session or printing of server proof.
It requires an admitted HTTPS endpoint and binding; redirects and URL
credentials/query/fragment are rejected. Do not disable TLS validation.

This draft submits one authentication request, discards response proof and
does not provision a workspace or retain a usable authenticated session.
There is no service wiring or permission to call the operating instance.
The tests inject a transport that sends mock values only to owned loopback
servers. A `.invalid` URL in a test is not a proposed operating endpoint.

Existing tailnet HTTP core5 access is not an HTTPS authentication candidate.
The observed Tailscale HTTPS root routes to action-hub, not the H API.
No proxy/DNS/certificate/firewall changes are part of this preparation.

Before owner input, the operator must separately confirm the existing
pre-enrolled authentication record, session-secret file, correct env/binding,
and actual protected HTTPS/private client path. Path existence and permissions
alone do not prove enrollment or identity. If supported metadata/binding
tools or registered files are unavailable, keep those items unverified.

One later owner action: only after those prerequisites are admitted, the
owner submits the existing password and current OTP once through the private
client. Missing pre-registration is a separate blocker; typing credentials
alone cannot complete preparation. Do not put credentials in shell commands,
history, screenshots, logs, chat or issues. This draft has not authenticated
the owner or prepared a production login URL/button.

TTY echo suppression and fixed error output protect normal client output.
Credentials still exist transiently in process memory and the protected
HTTP request; this is not protection against a compromised host, debugger or
external terminal/input recorder. Tests check client-controlled output only.
