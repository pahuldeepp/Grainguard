// Stage 08 real-browser OIDC proof (ADR-0014): Chromium drives the dashboard's
// oidc-client-ts authorization code + PKCE flow against local Dex, then the
// token the page actually sent is replayed to prove tenant scoping. Run with
// `make oidc-browser-test`. Never prints tokens.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

process.env.OIDC_BFF_URL = "http://127.0.0.1:4000";
const live = await import("./oidc-live.mjs");
const { ISSUER } = await import("./oidc-login.mjs");
const { bffDevice, deviceOf, check, failures, DEVICE } = live;
const DASHBOARD =
  process.env.OIDC_BROWSER_DASHBOARD_URL ?? "http://127.0.0.1:5173";
const START_DASHBOARD = process.env.OIDC_BROWSER_START_DASHBOARD !== "false";
const SHOTS = "evidence/stage08-oidc";
const password = process.env.OIDC_DEV_PASSWORD;

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await sleep(200);
  }
  throw new Error(`${url} not reachable`);
}

function startDashboard() {
  return spawn("npx", ["vite", "--host", "127.0.0.1"], {
    cwd: "apps/dashboard",
    env: {
      ...process.env,
      // The dev proxy defaults to the gateway port; point it at this test's BFF.
      BFF_DEV_URL: process.env.OIDC_BFF_URL,
      VITE_OIDC_AUTHORITY: ISSUER,
      VITE_OIDC_CLIENT_ID: "greenguard-dashboard",
      VITE_OIDC_AUDIENCE: "greenguard-dashboard",
    },
    stdio: "ignore",
    detached: true,
  });
}

async function signIn(page, user) {
  await page.goto(DASHBOARD);
  const authorizeRequest = page.waitForRequest((r) =>
    r.url().startsWith(`${ISSUER}/auth?`),
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const authorize = (await authorizeRequest).url();
  await page.waitForSelector('input[name="login"]');
  await page.fill('input[name="login"]', `${user}@greenguard.test`);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  return authorize;
}

async function searchAndCaptureToken(page) {
  await page.getByRole("link", { name: "Devices" }).click();
  await page.fill("#device-search", "oidc", { timeout: 10_000 });
  const [sent, response] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/graphql")),
    page.waitForResponse((r) => r.url().endsWith("/graphql")),
    page.getByRole("button", { name: "Search" }).click(),
  ]);
  const authorization = sent.headers().authorization ?? "";
  return {
    token: authorization.replace(/^Bearer /, ""),
    status: response.status(),
  };
}

async function userFlow(browser, user, own, other) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[browser] ${m.text()}`);
  });
  const authorize = new URL(await signIn(page, user));
  const params = authorize.searchParams;
  check(
    `${user}: browser used code + PKCE S256 with state and nonce`,
    params.get("response_type") === "code" &&
      params.get("code_challenge_method") === "S256" &&
      Boolean(params.get("state") && params.get("nonce")),
    `response_type=${params.get("response_type")} method=${params.get("code_challenge_method")}`,
  );
  const { token, status } = await searchAndCaptureToken(page);
  check(
    `${user}: dashboard GraphQL call authenticated`,
    status === 200 && token.split(".").length === 3,
    `BFF HTTP ${status}`,
  );
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  check(
    `${user}: token not in localStorage/sessionStorage`,
    !stored.includes(token),
    `storage keys: ${Object.keys(JSON.parse(stored)).length}`,
  );
  const mine = await bffDevice(token, own);
  const theirs = await bffDevice(token, other);
  check(
    `${user}: browser token reads own tenant only`,
    deviceOf(mine) === own && deviceOf(theirs) === null,
    `own=${deviceOf(mine)} other=${deviceOf(theirs)}`,
  );
  await page.screenshot({ path: `${SHOTS}/${user}-signed-in.png` });
  return { context, page };
}

async function sessionEdges(page) {
  await page.reload();
  const restored = await page
    .getByRole("button", { name: "Sign out" })
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(
    "reload restores the IdP session without persisting browser tokens",
    restored,
    `signed-in shell restored=${restored}`,
  );
  await page.goto(`${DASHBOARD}/auth/callback?code=forged&state=forged-state`);
  const alert = await page
    .getByRole("alert")
    .textContent({ timeout: 5000 })
    .catch(() => "");
  check(
    "forged callback state rejected by the client",
    /state/i.test(alert),
    `alert="${alert}"`,
  );
}

async function signOutFlow(page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  const back = await page
    .getByRole("button", { name: "Sign in" })
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  check(
    "sign-out returns to the sign-in screen",
    back,
    `sign-in visible=${back}`,
  );
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const stack = live.startStack();
  const vite = START_DASHBOARD ? startDashboard() : null;
  const browser = await chromium.launch();
  try {
    await stack.ready;
    await waitFor(DASHBOARD);
    const alice = await userFlow(browser, "alice", DEVICE.a, DEVICE.b);
    await signOutFlow(alice.page);
    const bob = await userFlow(browser, "bob", DEVICE.b, DEVICE.a);
    await sessionEdges(bob.page);
  } finally {
    await browser.close();
    if (vite) process.kill(-vite.pid, "SIGKILL");
    stack.stop();
  }
  console.log(
    failures.length
      ? `FAILED: ${failures.join("; ")}`
      : "ALL BROWSER OIDC CHECKS PASSED",
  );
  process.exitCode = failures.length ? 1 : 0;
}

await main();
