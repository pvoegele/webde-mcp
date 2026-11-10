/**
 * One-time helper: obtains a Google refresh token for Drive (scope drive.file).
 * Run on the server:  docker compose run --rm webde-mcp node dist/google-auth.js
 */
import { createInterface } from "node:readline/promises";

const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  console.error("GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET zuerst in .env eintragen.");
  process.exit(1);
}
const redirect = "http://localhost";
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
  });

console.log("\n1) Diesen Link im Browser auf deinem PC öffnen und mit dem Google-Konto anmelden:\n");
console.log(url);
console.log(
  '\n2) Danach landet der Browser auf einer Fehlerseite "localhost nicht erreichbar" – das ist richtig.' +
    "\n   Die komplette Adresse aus der Adresszeile kopieren (beginnt mit http://localhost/?code=...).\n",
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("3) Adresse hier einfügen: ")).trim();
rl.close();

let code = answer;
try {
  code = new URL(answer).searchParams.get("code") ?? answer;
} catch {
  /* user pasted only the code */
}

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
});
const j: any = await res.json();
if (!res.ok || !j.refresh_token) {
  console.error("\nFehlgeschlagen:", j.error ?? res.status, j.error_description ?? "");
  process.exit(1);
}
console.log("\n✔ Erfolgreich. Diese Zeile in die .env eintragen:\n");
console.log(`GOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
