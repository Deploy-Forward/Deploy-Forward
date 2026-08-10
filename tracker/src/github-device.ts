/**
 * GitHub Device Authorization Grant — the VERIFIED login path for the headless tracker
 * (the Strava "verified-by-construction" model). A CLI can't receive a browser redirect, so
 * we use the device flow: request a code, show the user a short code + URL, and poll until
 * they authorize in their browser.
 *
 * SECURITY: device flow needs only the PUBLIC client_id — never the client secret (GitHub:
 * "incorrect_client_credentials … the client_secret is not needed for the device flow"). So
 * the npx package can ship the client_id in the open. The resulting access token proves the
 * user really authorized; our server introspects it (GET /user) to set github_verified —
 * server-side introspection, never a client-asserted login (the spec's anti-spoof rule).
 *
 * No dependencies — global fetch (Node >= 20). Pure protocol; the CLI supplies display + I/O.
 */

const GH = "https://github.com";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function githubError(code: string | undefined): string {
  switch (code) {
    case "device_flow_disabled":
      return "Device flow isn't enabled on the GitHub OAuth app (enable it in the app settings).";
    case "incorrect_client_credentials":
      return "The GitHub client_id is wrong for this app.";
    case "unsupported_grant_type":
      return "GitHub rejected the device grant type.";
    case "incorrect_device_code":
      return "The device code was rejected by GitHub.";
    default:
      return `GitHub device flow error: ${code ?? "unknown"}.`;
  }
}

/** Step 1 — request the device + user verification codes. */
export async function requestDeviceCode(clientId: string, scope = "read:user"): Promise<DeviceCode> {
  const res = await fetch(`${GH}/login/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<DeviceCode> & { error?: string };
  if (!res.ok || data.error) throw new Error(githubError(data.error));
  if (!data.device_code || !data.user_code) throw new Error("GitHub returned an incomplete device code.");
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri ?? `${GH}/login/device`,
    expires_in: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/**
 * Step 3 — poll for the access token until the user authorizes, the code expires, or they
 * cancel. Honors `interval`, backs off +5s on `slow_down`, keeps polling on
 * `authorization_pending`. Returns the access token (an opaque string the server introspects).
 */
export async function pollForToken(clientId: string, dc: DeviceCode): Promise<string> {
  let interval = Math.max(5, dc.interval || 5);
  const deadline = Date.now() + dc.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let data: { access_token?: string; error?: string; interval?: number };
    try {
      const res = await fetch(`${GH}/login/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, device_code: dc.device_code, grant_type: GRANT }),
      });
      data = (await res.json().catch(() => ({}))) as typeof data;
    } catch {
      continue; // transient network blip mid-ceremony — keep polling until the code expires
    }

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case "authorization_pending":
        break; // user hasn't entered the code yet — keep polling at `interval`
      case "slow_down":
        interval = Math.max(interval + 5, Number(data.interval) || interval + 5);
        break;
      case "access_denied":
        throw new Error("Authorization was cancelled in the browser.");
      case "expired_token":
        throw new Error("The code expired before you authorized — run login again.");
      default:
        throw new Error(githubError(data.error));
    }
  }
  throw new Error("Timed out waiting for GitHub authorization.");
}

