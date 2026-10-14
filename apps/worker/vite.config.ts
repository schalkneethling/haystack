import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The build copies these files into the static assets. wrangler.jsonc's `assets.directory`
  // must name the same directory, because `wrangler dev` and the tests read that one.
  publicDir: "../web/public",
  plugins: [cloudflare()],
});
