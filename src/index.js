// Forwards /api/* to the coordinator; everything else is the static site in web/.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(url.pathname + url.search, env.COORDINATOR_ORIGIN);
      try {
        return await fetch(new Request(target, request));
      } catch {
        return Response.json({ error: "coordinator offline" }, { status: 503 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
