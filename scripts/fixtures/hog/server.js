// Never reached: the build is supposed to die first. Present only so that
// railpack detects a valid start command and produces a complete plan.
const http = require("node:http");

const port = Number(process.env.PORT) || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hog\n");
  })
  .listen(port, () => console.log(`[hog] listening on ${port}`));
