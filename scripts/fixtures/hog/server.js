// Jamais atteint : le build est censé mourir avant. Présent uniquement pour que
// Nixpacks détecte une commande de démarrage valide et génère un plan complet.
const http = require("node:http");
const port = Number(process.env.PORT) || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hog\n");
  })
  .listen(port, () => console.log(`[hog] listening on ${port}`));
