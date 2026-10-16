import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { enrollThroughCli } from "./self-entry-enroll-cli";
import {
  ENROLLMENT_BIND_HOST,
  ENROLLMENT_BIND_PORT,
  ENROLLMENT_ORIGIN,
  enrollmentAvailability,
  enrollmentListener,
  submitOperatorEnrollment,
} from "./self-entry-enroll";

const FORM = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>운영자 등록</title>
<style>
  body { margin: 0; background: #f4f7f5; color: #17221d; font: 16px/1.65 Inter, Pretendard, sans-serif; }
  main { width: min(480px, calc(100% - 32px)); margin: 24px auto; }
  h1 { font-size: 28px; line-height: 1.2; }
  form { display: grid; gap: 16px; background: #fff; border: 1px solid #ccd7d1; border-radius: 10px; padding: 22px; }
  label { display: grid; gap: 8px; font-weight: 600; }
  input, button { min-height: 48px; font: inherit; }
  input { border: 1px solid #ccd7d1; border-radius: 6px; padding: 12px; }
  button { border: 1px solid #176b47; border-radius: 6px; background: #176b47; color: #fff; font-weight: 600; }
  p { color: #526159; }
</style>
<main>
  <h1>운영자 등록</h1>
  <p>이 화면은 서버의 루프백 전용 포트에서만 열립니다.</p>
  <form id="enroll" autocomplete="off">
    <label>비밀번호 <input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="72"></label>
    <label>비밀번호 확인 <input name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="72"></label>
    <label>OTP 비밀키 <input name="totpSecret" type="password" autocomplete="off" required minlength="32" maxlength="32" spellcheck="false"></label>
    <label>현재 OTP <input name="totp" type="password" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label>
    <button type="submit">등록</button>
  </form>
  <p id="notice" role="status"></p>
</main>
<script>
  const form = document.getElementById("enroll");
  const notice = document.getElementById("notice");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const password = data.get("password");
    const confirm = data.get("confirm");
    const totpSecret = data.get("totpSecret");
    const totp = data.get("totp");
    form.reset();
    if (password !== confirm) { notice.textContent = "비밀번호 확인이 일치하지 않습니다."; return; }
    const result = await fetch("/api/self-entry/enroll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, totpSecret, totp }), cache: "no-store",
    });
    notice.textContent = result.status === 201 ? "등록되었습니다. 다음 OTP부터 로그인하세요." : "이 주소에서는 등록할 수 없습니다.";
  });
</script>
`;

function deniedPage(): string {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>운영자 등록</title><main><h1>이 주소에서는 등록할 수 없습니다</h1><p>등록은 서버의 루프백 전용 포트에서만 열립니다.</p></main>`;
}

export async function enrollmentHttpResponse(
  socket: { localPort?: number; remoteAddress?: string | null | undefined },
  request: Request,
  options: { statePath: string | undefined; now: number },
): Promise<Response> {
  const listener = enrollmentListener(socket);
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/login/enroll") {
    const availability = enrollmentAvailability(listener, options.statePath);
    if (availability !== "open") {
      return new Response(deniedPage(), { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(FORM, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/self-entry/enroll" && request.method === "GET") {
    const availability = enrollmentAvailability(listener, options.statePath);
    if (availability === "denied") {
      return Response.json({ error: "ENROLLMENT_HOST_DENIED" }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ open: availability === "open" }, { status: 200, headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/self-entry/enroll" && request.method === "POST") {
    return submitOperatorEnrollment(request, { ...options, write: enrollThroughCli, listener });
  }
  return new Response(null, { status: 404 });
}

function headerRecord(headers: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out.set(key, value);
    else if (Array.isArray(value)) out.set(key, value.join(", "));
  }
  return out;
}

export function startEnrollmentListener(options: { statePath: string | undefined }): Promise<void> {
  const server = createServer((req, res) => {
    void readBody(req).then(async body => {
      const headers = headerRecord(req.headers);
      const method = req.method ?? "GET";
      const request = method === "GET" || method === "HEAD"
        ? new Request(`${ENROLLMENT_ORIGIN}${req.url ?? "/"}`, { method, headers })
        : new Request(`${ENROLLMENT_ORIGIN}${req.url ?? "/"}`, { method, headers, body: body.toString("utf8") });
      const response = await enrollmentHttpResponse(req.socket, request, { statePath: options.statePath, now: Date.now() });
      await writeResponse(res, response);
    }).catch(() => {
      res.writeHead(403, { "cache-control": "no-store" }).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ENROLLMENT_BIND_PORT, ENROLLMENT_BIND_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port !== ENROLLMENT_BIND_PORT) {
        server.close();
        reject(new Error("ENROLLMENT_LISTENER_REJECTED"));
        return;
      }
      resolve();
    });
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
