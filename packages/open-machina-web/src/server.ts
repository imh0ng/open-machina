import { serve } from "bun";
import { join } from "path";

const PORT = 4444;
const UI_ROOT = join(import.meta.dir, "ui");

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(UI_ROOT, "index.html")));
    }

    if (url.pathname === "/style.css") {
      return new Response(Bun.file(join(UI_ROOT, "style.css")));
    }

    if (url.pathname === "/app.js") {
      const build = await Bun.build({
        entrypoints: [join(UI_ROOT, "app.ts")],
        minify: false,
      });
      if (build.success) {
        return new Response(build.outputs[0]);
      }
      return new Response("Build failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Machina Web UI running on http://localhost:${PORT}`);
export default server;
