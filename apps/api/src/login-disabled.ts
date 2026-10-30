/** Read bypass for an already bound loopback peer. Never consults forwarded headers. */
export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (address.startsWith("::ffff:")) return isLoopbackAddress(address.slice("::ffff:".length));
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

export function loginDisabledLoopbackRead(input: {
  readonly flag: string | undefined;
  readonly method: string;
  readonly peerAddress: string | undefined;
  readonly binding: { readonly workspaceId: string; readonly principalId: string; readonly kind: string } | undefined;
}): boolean {
  if (input.flag !== "1") return false;
  if (input.method !== "GET" && input.method !== "HEAD") return false;
  const binding = input.binding;
  if (!binding?.workspaceId.trim() || !binding.principalId.trim() || binding.kind !== "human") return false;
  return isLoopbackAddress(input.peerAddress);
}
