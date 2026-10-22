/**
 * Where the code runner lives, and who may use it.
 *
 * Programs never run on PR0L1NE's own site. The app embeds a small page
 * from another site, the runner, in a hidden iframe, and the runner runs
 * the code in a worker (see sandboxWorker.ts and runner/relay.ts, and
 * "Security" in docs/how-it-works.md). Being another site is the point:
 * the browser keeps everything of PR0L1NE's (its storage, and later its
 * logins) out of the runner's reach, whatever the code in it does.
 *
 * This file has no DOM in it: the two Vite configs use it at build time
 * (which runner the app talks to; which pages may embed the runner, for
 * its headers), and the runner page uses originAllowed() at run time.
 */

/** The runner's Cloudflare Pages project: its site is `<name>.pages.dev`. */
export const RUNNER_PROJECT = "pr0l1ne-run";
/** The app's Cloudflare Pages project (for branch previews). */
export const APP_PROJECT = "pr0l1ne";
/** The app's production branch. */
export const PRODUCTION_BRANCH = "main";

/** The live runner. */
export const PRODUCTION_RUNNER = `https://${RUNNER_PROJECT}.pages.dev/`;
/** The runner `npm run dev` starts (see scripts/dev.mjs). */
export const DEV_RUNNER = "http://127.0.0.1:5174/";
/** The runner `npm run preview` serves (see scripts/preview.mjs). */
export const PREVIEW_RUNNER = "http://127.0.0.1:4174/";

/**
 * The pages that may embed the runner, when it's built on Cloudflare: the
 * app's domain, its pages.dev address, and its branch previews
 * (`<branch>.pr0l1ne.pages.dev`, which are only ever this project's).
 */
export const DEPLOYED_APP_ORIGINS = [
  "https://pr0l1ne.com",
  "https://www.pr0l1ne.com",
  `https://${APP_PROJECT}.pages.dev`,
  `https://*.${APP_PROJECT}.pages.dev`,
];

/** ...and when it's built anywhere else: the app on this machine (any port). */
export const LOCAL_APP_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"];

/** What a build can see of where it's running (process.env). */
export type BuildEnv = Record<string, string | undefined>;

/** Built by Cloudflare Pages (it sets CF_PAGES=1). */
export const onCloudflare = (env: BuildEnv) => env.CF_PAGES === "1";

/**
 * A branch's preview name, as Cloudflare makes it: lowercase, with anything
 * but a letter or digit made a hyphen (`fix/api` -> `fix-api`).
 */
export function branchAlias(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/**
 * Which runner a build of the app talks to:
 *   VITE_RUNNER_URL set          that one (an override, for anything unusual)
 *   on Cloudflare, main          the live runner
 *   on Cloudflare, a branch      the same branch's preview of the runner
 *   anywhere else                the runner on this machine (npm run preview)
 */
export function runnerUrlFor(env: BuildEnv): string {
  if (env.VITE_RUNNER_URL) return withSlash(env.VITE_RUNNER_URL);
  if (!onCloudflare(env)) return PREVIEW_RUNNER;
  const branch = env.CF_PAGES_BRANCH;
  if (!branch || branch === PRODUCTION_BRANCH) return PRODUCTION_RUNNER;
  return `https://${branchAlias(branch)}.${RUNNER_PROJECT}.pages.dev/`;
}

/** Which pages may embed a build of the runner (RUNNER_APP_ORIGINS, comma-separated, overrides). */
export function appOriginsFor(env: BuildEnv): string[] {
  if (env.RUNNER_APP_ORIGINS) {
    return env.RUNNER_APP_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return onCloudflare(env) ? DEPLOYED_APP_ORIGINS : LOCAL_APP_ORIGINS;
}

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

/**
 * Does an origin match one of the patterns? As CSP sources match: an exact
 * origin, `*.` for any subdomain (not the domain itself), `:*` for any port.
 */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // only bare origins: no paths, no "null"
  return patterns.some((pattern) => {
    const m = /^(https?):\/\/(\*\.)?([^:/]+)(?::(\d+|\*))?$/.exec(pattern);
    if (!m) return false;
    const [, scheme, anySub, host, port] = m;
    if (url.protocol !== `${scheme}:`) return false;
    const hostOk = anySub ? url.hostname.endsWith(`.${host}`) : url.hostname === host;
    const portOk = port === "*" || (port ?? "") === url.port;
    return hostOk && portOk;
  });
}

/**
 * The runner's own rules, sent as headers on every file it serves (Cloudflare
 * reads them from `_headers`; the Vite servers send them in development):
 *
 *   default-src 'none'       nothing, unless allowed below
 *   script-src 'self'        its own scripts only; 'unsafe-eval' because the
 *     'unsafe-eval'          JavaScript tracer runs the program with
 *     'wasm-unsafe-eval'     new Function(), and Pyodide is WebAssembly
 *   worker-src 'self'        workers from its own files
 *   connect-src 'self'       fetch only its own files (Pyodide's standard
 *                            library): no other site, ever
 *   frame-ancestors ...      only the app may embed it
 *   base-uri / form-action   'none': no other way out
 */
export function runnerPolicy(appOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
    `frame-ancestors ${appOrigins.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Every header the runner sends, besides caching. */
export function runnerHeaders(appOrigins: readonly string[]): Record<string, string> {
  return {
    "Content-Security-Policy": runnerPolicy(appOrigins),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=(), clipboard-read=(), clipboard-write=()",
  };
}
