export default {
  async fetch(request: Request, env: { ASSETS: { fetch: (r: Request) => Promise<Response> } }) {
    const url = new URL(request.url);
    if (url.hostname === "www.athens-light.app") {
      url.hostname = "athens-light.app";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
