/** Shared private OAuth client authentication; never expose these credentials to tools. */
export function basicClientAuthorization(clientId: string, clientSecret: string): string {
  const encode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString("base64")}`;
}

export class ReauthenticationRequired extends Error {
  constructor() {
    super("Authorization required.");
    this.name = "ReauthenticationRequired";
  }
}
