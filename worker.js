import { onRequestPost as tokenPost, onRequestGet as tokenGet, onRequestOptions as tokenOptions } from "./functions/api/token.js";
import { onRequestPost as structPost, onRequestGet as structGet, onRequestOptions as structOptions } from "./functions/api/structure.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/token" || url.pathname === "/api/token/") {
      if (request.method === "OPTIONS") return tokenOptions();
      if (request.method === "GET") return tokenGet();
      return tokenPost({ request, env, ctx });
    }

    if (url.pathname === "/api/structure" || url.pathname === "/api/structure/") {
      if (request.method === "OPTIONS") return structOptions();
      if (request.method === "GET") return structGet();
      return structPost({ request, env, ctx });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};
