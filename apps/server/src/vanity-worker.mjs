// REQ-LAUNCH-006: búsqueda de una dirección de mint con prefijo/sufijo, en un hilo aparte para no bloquear la
// API, el indexer ni los reenvíos del sender. JavaScript plano (sin TS) para cargar igual con tsx, vitest y node.
// Recibe { prefix, suffix, ci }; informa { attempts } cada ~250 ms y { found: { seed, pub } } al acertar.
import { parentPort, workerData } from "node:worker_threads";
import { generateKeyPairSync } from "node:crypto";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => {
  let x = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (x > 0n) {
    s = A[Number(x % 58n)] + s;
    x /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
};

const { prefix, suffix, ci } = workerData;
const norm = (s) => (ci ? s.toLowerCase() : s);
const p = norm(prefix);
const q = norm(suffix);
let attempts = 0;
let last = Date.now();
for (;;) {
  const k = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
  const pub = k.publicKey.subarray(-32);
  const addr = norm(b58(pub));
  attempts++;
  if (addr.startsWith(p) && addr.endsWith(q)) {
    parentPort.postMessage({ attempts, found: { seed: k.privateKey.subarray(-32).toString("hex"), pub: pub.toString("hex") } });
    attempts = 0;
    break;
  }
  if ((attempts & 1023) === 0 && Date.now() - last >= 250) {
    parentPort.postMessage({ attempts });
    attempts = 0;
    last = Date.now();
  }
}
