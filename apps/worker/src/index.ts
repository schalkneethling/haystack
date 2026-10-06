// Every route is added in a later phase. Until then, nothing is served.
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
