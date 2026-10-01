"use client";

const CSRF_COOKIE = "core5_csrf";

/** Adds the session cookie and CSRF header only when an owner session exists. */
export function ownerFetchInit(init: RequestInit = {}): RequestInit {
  const csrf = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  if (!csrf) return init;
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", decodeURIComponent(csrf));
  return { ...init, credentials: "include", headers };
}
