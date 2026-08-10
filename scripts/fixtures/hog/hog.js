// Bombe mémoire exécutée pendant la phase de BUILD (npm run build).
//
// C'est un substitut à un vrai build Next.js sur une VM 2 Go : même issue,
// 200 ms à écrire, et déterministe. Si le cap fonctionne, ce process est tué
// par le cgroup du builder AVANT d'avoir épuisé la RAM de la VM — et les
// services qui tournent déjà ne bronchent pas.
//
// Buffer.alloc avec une valeur de remplissage force l'engagement réel des
// pages : sans ça on n'alloue que de l'adressage virtuel et le cgroup ne se
// déclenche jamais.
const chunks = [];
let mb = 0;

for (;;) {
  chunks.push(Buffer.alloc(64 * 1024 * 1024, 1));
  mb += 64;
  console.log(`[hog] ${mb} MB alloués`);
}
