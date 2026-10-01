"use client";

import { useEffect } from "react";
import { ownerFetchInit } from "./owner-browser";

/** Browser mutations pick up the CSRF header when a session cookie exists. */
export function OwnerFetchPatch() {
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => orig(input, ownerFetchInit(init));
    return () => {
      window.fetch = orig;
    };
  }, []);
  return null;
}
