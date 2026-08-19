import type { Express } from "express";

export interface RegisteredRoute {
  method: string;
  path: string;
}

// Express doesn't expose the routing table it builds, so reading it means
// walking the internal layer stack: each layer either *is* a route (with
// its own methods) or is a mounted sub-router whose prefix only exists as
// the regexp the mount compiled to. Narrow, unofficial shapes - kept in
// the test tree, and only used to compare the routing table against the
// documented one.
interface Layer {
  name: string;
  regexp?: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

/**
 * Recovers a router's mount path from the regexp Express compiled for it,
 * e.g. /^\/eligibility\/?(?=\/|$)/i -> "/eligibility". Returns "" for the
 * catch-all mount that middleware registers, which contributes no prefix.
 */
function mountPathFromRegexp(regexp: RegExp | undefined): string {
  if (!regexp) return "";
  const source = regexp.source;
  if (source === "^\\/?(?=\\/|$)" || source === "^\\/?$") return "";
  const match = source.match(/^\^((?:\\\/[^\\^$?(]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!match) return "";
  return match[1].replace(/\\\//g, "/");
}

function collect(stack: Layer[], prefix: string, out: RegisteredRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path}`.replace(/\/$/, "") || "/";
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) out.push({ method: method.toUpperCase(), path });
      }
      continue;
    }
    if (layer.handle?.stack) {
      collect(layer.handle.stack, `${prefix}${mountPathFromRegexp(layer.regexp)}`, out);
    }
  }
}

/** Every (method, path) pair the app will actually answer. */
export function listRegisteredRoutes(app: Express): RegisteredRoute[] {
  const router = (app as unknown as { _router?: { stack?: Layer[] } })._router;
  const routes: RegisteredRoute[] = [];
  collect(router?.stack ?? [], "", routes);
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}
