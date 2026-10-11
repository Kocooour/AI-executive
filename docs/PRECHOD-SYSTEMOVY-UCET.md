# Přechod na samostatný systémový účet služby

Tento dokument je provozní postup pro nasazovacího agenta (Codex). Odpovídá na nález v [SECURITY_AUDIT.md](../SECURITY_AUDIT.md): služba `ai-executive` dnes běží pod sdíleným účtem `hermesadmin` (stejný účet používá agent Hermes). Cílem je spustit ji pod vlastním neprivilegovaným účtem `ai-executive` s hardeningem ze šablony [`deployment/ai-executive.service`](../deployment/ai-executive.service).

## Co se mění a proč

| | Dnes | Po přechodu |
| --- | --- | --- |
| Účet služby | `hermesadmin` (sdílený s Hermesem) | `ai-executive` (systémový, `nologin`, bez domovského adresáře) |
| Kód | git checkout v domovském adresáři `hermesadmin` | `/opt/ai-executive`, vlastník `root`, služba v něm nemůže zapisovat |
| Data | `<checkout>/.data` (`store.sqlite`, `backups/`) | `/var/lib/ai-executive`, `ai-executive:ai-executive`, `0700` |
| Tajné údaje | `<checkout>/.env` | `/etc/ai-executive/ai-executive.env`, `root:root`, `0600` |
| Spuštění | dle stávající jednotky | `/usr/bin/node .../next start` přes hardened šablonu (`ProtectSystem=strict`, `ProtectHome=true`, bez capabilities) |
| HTTPS | Tailscale Serve `https://vm13861.tail412944.ts.net:8443` → `http://127.0.0.1:3000` | beze změny |

Důsledek: sdílený účet už nemůže číst data ani tajné údaje Lumi ani měnit kód, který s nimi běží. Aplikace se nemění, jen místo, odkud čte data (`AI_EXECUTIVE_DATA_DIR` musí být absolutní cesta, jinak se služba nespustí).

Pravidla pro celý postup:

- Vše se spouští jako `root` (`sudo -i`). Žádný krok se neprovádí jako `hermesadmin`.
- **Nikdy nečíst, nevypisovat ani nediffovat hodnoty tajných údajů.** Z `.env` se smí vypsat jen názvy klíčů (`sed 's/=.*//'`), počty řádků a kontrolní součty.
- Původní `.data` a `.env` se do kroku 10 jen kopírují, nepřesouvají. Návrat zpět (krok 9) se na ně spoléhá.
- Při jakémkoli neočekávaném stavu **zastavit a nahlásit**, ne improvizovat. Každý krok má „Kontrolu“ (očekávaný výsledek) a „Když selže“.
- Proměnné mezi bloky drží soubor `/var/backups/ai-executive/migrace.vars` (vytvoří ho krok 1, neobsahuje tajné údaje). Každý další blok jej načte, takže postup funguje i v oddělených shellech.

Okno: vlastník potvrdil, že přechod lze provést kdykoli (systém se ještě reálně nepoužívá). Výpadek je v řádu minut.

## Zkouška nanečisto

Privilegovaný systemd kontejner v tomto prostředí nebyl povolen, proto vznikla nejbližší bezpečná aproximace: [`deployment/rehearsal/rehearse.sh`](../deployment/rehearsal/rehearse.sh). Spouští se jako root v **jednorázovém** stroji nebo kontejneru (`pnpm install --frozen-lockfile && pnpm build`, pak `sudo deployment/rehearsal/rehearse.sh`). Skript vytvoří uživatele `lumi-old` (náhrada za `hermesadmin`, domov `0750`) a `ai-executive`, vše ostatní drží pod jedním prefixem (výchozí dočasný adresář), na konci uklidí procesy, účty i prefix a vypíše `RESULT: PASS|FAIL`. Porty: `3160` (starý), `3162` (nový).

Nacvičeno (kroky 2–5, 8 a 9 upravené na prefix, bez systemd):

- stará instance pod `lumi-old` z domova s `.data` a `.env`, nasazená přes API (přihlášení, `PUT /api/store`, záloha),
- záloha s kontrolním součtem a `check-data` na kopii, kopie dat a `.env` do nových umístění se správnými vlastníky a režimy, odstranění `AI_EXECUTIVE_DATA_DIR`/`PORT`/`NODE_ENV` z env souboru,
- start nové instance pod `ai-executive` z kořenem vlastněného adresáře kódu s `AI_EXECUTIVE_DATA_DIR`, stejná čísla záznamů, `401` bez relace a `200` s relací, přihlášení stejným heslem, nová instance nečte starý domov, `.env` ani starou databázi, po sérii požadavků a vytvoření zálohy se v adresáři kódu nic nezměnilo, zálohy skončily v novém adresáři jako `0600`,
- návrat zpět: znovu start staré instance z nedotčených dat.

**Nelze nacvičit** (musí se potvrdit na serveru v kroku 8): vlastnosti, které dodává jen systemd: `ProtectSystem=strict` (zápis do `/opt` a mimo `StateDirectory` selže), mount namespace `ProtectHome=true`, parsování `EnvironmentFile` (rozdíly proti dotenv, krok 1), `StateDirectory`/`StateDirectoryMode`, `UMask=0077`, `PrivateTmp`, `CapabilityBoundingSet=`, `NoNewPrivileges`, `Restart=`, sandbox skutečného `systemd-analyze security` skóre a Tailscale Serve.

## Postup přechodu pro Codex

### 0. Předpoklady a stop podmínky

Pokračovat jen pokud platí všechno z toho:

- Fáze A je nasazená a produkce běží (`systemctl is-active ai-executive` = `active`).
- Stávající checkout už obsahuje release s tímto postupem (soubory `scripts/check-data.mjs`, `lib/data-dir.ts`, `deployment/ai-executive.service`). Pokud ne, nejdřív ho nasaďte dosavadním způsobem (záloha, `git merge --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, restart, kontroly) a až poté přejděte sem. Přechod tak mění jen místo běhu, ne verzi aplikace.
- Node.js je na `/usr/bin/node`, není pod `/home` a umí `node:sqlite` bez přepínačů (vyžadováno ≥ 22.5). Je dostupný `pnpm` ≥ 10 a `git`.
- Je dost místa (alespoň 3× velikost `.data` a 2 GB pro kód a závislosti).
- Stav je takový, jak postup popisuje. Cokoli neočekávaného (jiný účet, jiný port, další `EnvironmentFile`, další `.env.*` soubory, více jednotek) znamená **zastavit a nahlásit**.

```bash
set -euo pipefail
test "$(id -u)" -eq 0 || { echo "STOP: spustit jako root"; exit 1; }
systemctl is-active ai-executive
command -v node pnpm git
NODE_BIN=$(command -v node); echo "node: $NODE_BIN -> $(readlink -f "$NODE_BIN")"
test "$NODE_BIN" = /usr/bin/node || { echo "STOP: node neni na /usr/bin/node (sablona by nesla spustit)"; exit 1; }
case "$(readlink -f "$NODE_BIN")" in /home/*|/root/*) echo "STOP: node lezi v domovskem adresari (ProtectHome ho skryje)"; exit 1;; esac
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5)) process.exit(1); import("node:sqlite").then(()=>console.log("node",process.version,"node:sqlite OK"))'
pnpm --version
df -h / /var /opt | cat
```

**Kontrola:** `active`, `node: /usr/bin/node ...`, `node:sqlite OK`, verze pnpm 10.x, volné místo.
**Když selže:** zastavit, nahlásit přesný výpis. Node mimo `/usr/bin` nebo chybějící pnpm neřešit na vlastní pěst (úprava šablony či instalace nástrojů je rozhodnutí vlastníka).

### 1. Inventura (jen čtení)

Jediný zápis je soubor s proměnnými a adresář `/var/backups/ai-executive`.

```bash
set -euo pipefail
umask 077
install -d -m 0700 /var/backups/ai-executive
VARS=/var/backups/ai-executive/migrace.vars

OLD_USER=$(systemctl show ai-executive -p User --value)
OLD_DIR=$(systemctl show ai-executive -p WorkingDirectory --value)
FRAGMENT=$(systemctl show ai-executive -p FragmentPath --value)
test -n "$OLD_USER" -a "$OLD_USER" != root -a "$OLD_USER" != ai-executive || { echo "STOP: neocekavany User='$OLD_USER'"; exit 1; }
test -d "$OLD_DIR" || { echo "STOP: WorkingDirectory '$OLD_DIR' neexistuje"; exit 1; }
test "$FRAGMENT" = /etc/systemd/system/ai-executive.service || { echo "STOP: jednotka je jinde: $FRAGMENT"; exit 1; }
OLD_HOME=$(getent passwd "$OLD_USER" | cut -d: -f6)
OLD_ENV="$OLD_DIR/.env"
test -f "$OLD_ENV" || { echo "STOP: $OLD_ENV neexistuje"; exit 1; }

echo "== unit vcetne drop-inu"; systemctl cat ai-executive --no-pager | sed -E 's/((PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=).*/\1<skryto>/'
echo "== EnvironmentFiles (ocekavano prazdne)"; systemctl show ai-executive -p EnvironmentFiles --value
echo "== drop-iny"; systemctl show ai-executive -p DropInPaths --value | tr ' ' '\n'
echo "== klice Environment= v jednotce"; systemctl show ai-executive -p Environment --value | tr ' ' '\n' | sed 's/=.*//' | sort
echo "== ExecStart"; systemctl show ai-executive -p ExecStart --value | head -c 600; echo
echo "== porty"; ss -ltnp | grep -E ':(3000|8443)\b' || true
echo "== tailscale serve"; tailscale serve status || true
echo "== klice v .env"; sed -E '/^[[:space:]]*(#|$)/d; s/=.*//' "$OLD_ENV" | sort
echo "== .env soubory v checkoutu"; ls -A "$OLD_DIR" | grep -E '^\.env' || true
for KEY in AI_EXECUTIVE_DATA_DIR PORT NODE_ENV; do printf '%s: %s radku v .env\n' "$KEY" "$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$KEY=" "$OLD_ENV" || true)"; done
echo "== rozdily systemd EnvironmentFile vs dotenv (jen pocty radku)"
printf 'radky s "$": %s\nradky s prefixem export: %s\nradky s uvozovkami: %s\nradky s vice nez jednim "=": %s\nradky s " #" (komentar na radku): %s\n' \
  "$(grep -c '\$' "$OLD_ENV" || true)" "$(grep -cE '^[[:space:]]*export[[:space:]]' "$OLD_ENV" || true)" \
  "$(grep -cE "=[[:space:]]*[\"']" "$OLD_ENV" || true)" "$(grep -cE '=.*=' "$OLD_ENV" || true)" "$(grep -cE '[[:space:]]#' "$OLD_ENV" || true)"
stat -c '%a %U:%G %n' "$OLD_ENV" "$OLD_DIR" "$OLD_HOME"
printf 'OLD_USER=%q\nOLD_DIR=%q\nOLD_HOME=%q\nOLD_ENV=%q\n' "$OLD_USER" "$OLD_DIR" "$OLD_HOME" "$OLD_ENV" > "$VARS"
chmod 0600 "$VARS"
```

Určete umístění dat. Hodnota `AI_EXECUTIVE_DATA_DIR` je cesta, ne tajný údaj, smí se vypsat:

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
OLD_DATA=$(systemctl show ai-executive -p Environment --value | tr ' ' '\n' | sed -n 's/^AI_EXECUTIVE_DATA_DIR=//p' | head -n1)
[ -n "$OLD_DATA" ] || OLD_DATA=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?AI_EXECUTIVE_DATA_DIR=//p' "$OLD_DIR/.env" | head -n1 | tr -d "\"'")
[ -n "$OLD_DATA" ] || OLD_DATA="$OLD_DIR/.data"
case "$OLD_DATA" in /*) ;; *) OLD_DATA="$OLD_DIR/$OLD_DATA";; esac
echo "OLD_DATA=$OLD_DATA"; ls -la --time-style=+%F "$OLD_DATA" | awk '{print $1,$3,$4,$5,$6,$7}'
test -f "$OLD_DATA/store.sqlite" || { echo "STOP: store.sqlite nenalezen"; exit 1; }
test -f "$OLD_DIR/scripts/check-data.mjs" || { echo "STOP: stavajici checkout nema scripts/check-data.mjs (viz krok 0)"; exit 1; }

echo "== doplnek bezpecnostnich upozorneni"
if [ -f /etc/systemd/system/ai-executive.service.d/20-security-alerts.conf ]; then ALERTS=1; ls -ld /var/lib/ai-executive-security/outbox; else ALERTS=0; echo "neni nainstalovan"; fi
echo "== jine jednotky/cron odkazujici na stary adresar (jen nazvy souboru)"
grep -rIl -e "$OLD_DIR" -e "$OLD_DATA" /etc/systemd /etc/cron* /var/spool/cron 2>/dev/null || true

echo "== pocty zaznamu (zive, jen ke cteni)"
/usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" | tee /var/backups/ai-executive/inventura-pred.json

TS=$(date +%Y%m%d-%H%M%S)
OLD_HEAD=$(git -c safe.directory='*' -C "$OLD_DIR" rev-parse HEAD)
OLD_BRANCH=$(git -c safe.directory='*' -C "$OLD_DIR" branch --show-current)
ORIGIN_URL=$(git -c safe.directory='*' -C "$OLD_DIR" remote get-url origin)
echo "HEAD=$OLD_HEAD vetev=$OLD_BRANCH"; echo "origin (bez prihlasovacich udaju): $(printf '%s' "$ORIGIN_URL" | sed -E 's#//[^@/]*@#//#')"
git -c safe.directory='*' -C "$OLD_DIR" status --porcelain | head -n 20
{
  printf 'OLD_USER=%q\nOLD_DIR=%q\nOLD_HOME=%q\nOLD_ENV=%q\nOLD_DATA=%q\nALERTS=%q\nTS=%q\nBK=%q\nOLD_HEAD=%q\nOLD_BRANCH=%q\nORIGIN_URL=%q\n' \
    "$OLD_USER" "$OLD_DIR" "$OLD_HOME" "$OLD_ENV" "$OLD_DATA" "$ALERTS" "$TS" "/var/backups/ai-executive/pre-account-$TS" "$OLD_HEAD" "$OLD_BRANCH" "$ORIGIN_URL"
  cat <<'FUNCS'
# cmp_tables <pred.json> <po.json> [volatile,tables] [ignored,tables]: stabilni tabulky musi byt stejne,
# volatilni nesmi ubyt, ignorovane (zaznamy s kratkou platnosti) se jen vypisou.
cmp_tables() {
  /usr/bin/node -e '
    const fs = require("fs"); const [a, b, volatile = "", ignored = ""] = process.argv.slice(1);
    const x = JSON.parse(fs.readFileSync(a, "utf8")).tables, y = JSON.parse(fs.readFileSync(b, "utf8")).tables;
    const soft = new Set(volatile.split(",").filter(Boolean)), skip = new Set(ignored.split(",").filter(Boolean)); let bad = 0;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (skip.has(name)) { console.log("INFO", name, x[name], "->", y[name]); continue; }
      const ok = soft.has(name) ? (y[name] ?? 0) >= (x[name] ?? 0) : x[name] === y[name];
      if (!ok) { bad++; console.log("ROZDIL", name, x[name], "->", y[name]); }
    }
    console.log(bad ? "TABULKY: ROZDIL" : "TABULKY: shodne"); process.exit(bad ? 1 : 0);
  ' "$@"
}
# Po startu je meni sama sluzba (bezpecnostni log, plan. vyhodnoceni pozornosti kazdych 5 min, push, kalendar).
VOLATILE=security_events,security_alerts,notification_deliveries,metadata,attention_states,attention_history,pact_agent_runs
# Zaznamy, ktere se samy nahrazuji nebo vyprsi (5min navrhy AI, vyzvy passkey, udalosti obnovenych kalendaru).
IGNORED=ai_proposals,passkey_challenges,calendar_events
FUNCS
} > /var/backups/ai-executive/migrace.vars
chmod 0600 /var/backups/ai-executive/migrace.vars
echo "Ulozeno: /var/backups/ai-executive/migrace.vars"
```

**Kontrola (zastavit a nahlásit při odchylce):**

- `User` je jeden obyčejný účet (`hermesadmin`), `FragmentPath` je `/etc/systemd/system/ai-executive.service`.
- `EnvironmentFiles` je prázdné. V `.env` je to, co Next.js načítá z `cwd`. Jiné soubory `.env.*` v checkoutu (`.env.local`, `.env.production`) nejsou, Next je načítá také a postup by je nepřenesl.
- Klíče `Environment=` v jednotce jsou jen z množiny `NODE_ENV`, `PORT`, `AI_EXECUTIVE_DATA_DIR`, `AI_EXECUTIVE_SECURITY_OUTBOX_DIR`. Jiné klíče by se musely přenést do env souboru; to je rozhodnutí k nahlášení.
- Port je `3000` na `127.0.0.1` a `tailscale serve status` ukazuje `https://vm13861.tail412944.ts.net:8443` → `http://127.0.0.1:3000`.
- Řádky `.env` s `$`, prefixem `export`, uvozovkami, dalším `=` nebo komentářem na řádku: **systemd `EnvironmentFile` se liší od dotenv, který používá Next.js**. systemd neexpanduje `$VAR`, prefix `export` neakceptuje, uvozovky odstraňuje jinak a komentář na řádku nepodporuje. Pokud je počet `$` a `export` nenulový, **zastavit a nahlásit** (hodnota by se po přechodu jinak interpretovala, např. heslový hash nebo secret). Počty uvozovek a komentářů nahlásit také; hodnoty nevypisovat. Hash hesla v aktuálním formátu `scrypt:<sůl>:<hash>` je bezpečný.
- `check-data` vypíše `"integrity":"ok"` a počty tabulek (zapsané do `inventura-pred.json`; slouží jen jako informace, závazný základ se pořídí po zastavení v kroku 2).
- `git status --porcelain` je prázdné (čistý checkout).

**Když selže:** nic se zatím nezměnilo, jen vznikl soubor s proměnnými. Nahlásit a skončit.

### 2. Záloha a ověření

Zastaví službu (konzistentní kopie včetně případných `-wal`/`-shm`), zkopíruje data, `.env` a jednotku s drop-iny do zálohy a ověří kopii.

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
systemctl stop ai-executive
systemctl is-active ai-executive && { echo "STOP: sluzba se nezastavila"; exit 1; } || true
install -d -m 0700 "$BK" "$BK/systemd"

cp -a "$OLD_DATA" "$BK/data"
cp -a "$OLD_ENV" "$BK/env"
cp -a /etc/systemd/system/ai-executive.service "$BK/systemd/"
if [ -d /etc/systemd/system/ai-executive.service.d ]; then cp -a /etc/systemd/system/ai-executive.service.d "$BK/systemd/"; fi
find "$BK" -type d -exec chmod 0700 {} +; find "$BK" -type f -exec chmod 0600 {} +
chown -R root:root "$BK"
(cd "$BK" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
(cd "$BK" && sha256sum -c --quiet MANIFEST.sha256) && echo "Manifest OK ($(wc -l < "$BK/MANIFEST.sha256") souboru)"
ls -A "$OLD_DATA" | grep -E -- '-(wal|shm)$' && echo "Pozn.: -wal/-shm byly zkopirovany spolu s databazi" || echo "-wal/-shm nejsou (cista kopie)"

/usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" > "$BK/fakta-original.json"
/usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$BK/data/store.sqlite" > "$BK/fakta-kopie.json"
cat "$BK/fakta-kopie.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-kopie.json"
test "$(sha256sum < "$OLD_DATA/store.sqlite")" = "$(sha256sum < "$BK/data/store.sqlite")" && echo "sha256 databaze kopie = original"
```

**Kontrola:** `Manifest OK`, kopie má `"integrity":"ok"`, `TABULKY: shodne`, shodné sha256 databáze. Zálohu `fakta-original.json` používají všechna další porovnání jako závazný základ.
**Když selže:** službu **ihned spustit zpět** (`systemctl start ai-executive`), ověřit `/api/auth/status`, nahlásit. Nic dalšího nedělat, originály jsou nedotčené.

### 3. Účet

```bash
set -euo pipefail
if getent passwd ai-executive >/dev/null; then
  echo "Ucet existuje:"; id ai-executive
else
  useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ai-executive
fi
id ai-executive
getent passwd ai-executive
```

**Kontrola:** `id` ukazuje jedinou skupinu `ai-executive` (uid < 1000, shell `/usr/sbin/nologin`, domov `/nonexistent`). Nesmí být ve skupinách `hermesadmin`, `hermes`, `sudo`, `adm`, `docker` ani v žádné jiné. `id -nG ai-executive` vypíše jen `ai-executive`.
**Když selže:** pokud účet už existuje, ale má další skupiny nebo shell (někdo jej používá jinak), zastavit a nahlásit; nemazat. Jinak `userdel ai-executive` a znovu.

### 4. Kód do `/opt/ai-executive`

Klonuje se lokálně ze stávajícího checkoutu (stejný commit, bez síťových přihlašovacích údajů), pak se nastaví skutečný `origin` pro budoucí nasazování.

```bash
set -euo pipefail
umask 022
. /var/backups/ai-executive/migrace.vars
test ! -e /opt/ai-executive || { echo "STOP: /opt/ai-executive uz existuje"; exit 1; }
case "$ORIGIN_URL" in *://*@*) echo "STOP: origin obsahuje prihlasovaci udaje; nahlasit"; exit 1;; esac
test -n "$OLD_BRANCH" || { echo "STOP: stary checkout nema vetev (detached HEAD)"; exit 1; }

git -c safe.directory='*' clone --no-hardlinks "$OLD_DIR" /opt/ai-executive
cd /opt/ai-executive
git checkout -B "$OLD_BRANCH" "$OLD_HEAD"
git remote set-url origin "$ORIGIN_URL"
test "$(git rev-parse HEAD)" = "$OLD_HEAD" && echo "HEAD = $OLD_HEAD"
git status --porcelain | head
git ls-remote origin HEAD >/dev/null && git fetch origin && git branch --set-upstream-to="origin/$OLD_BRANCH" "$OLD_BRANCH" \
  || echo "UPOZORNENI: root nema pristup k origin; pro krok 11 bude potreba pristup (nahlasit vlastnikovi)"

pnpm install --frozen-lockfile 2>&1 | tee /var/backups/ai-executive/pnpm-install.log | tail -n 15
pnpm build 2>&1 | tail -n 8

chown -R root:root /opt/ai-executive
chmod -R go-w /opt/ai-executive
chmod 0755 /opt /opt/ai-executive
echo "== kontroly"
ls -A /opt/ai-executive | grep -E '^\.(env|data)' && { echo "CHYBA: .env/.data v kodu"; exit 1; } || echo "zadny .env* ani .data v /opt/ai-executive"
find /opt/ai-executive -not -user root | head -n 3
find /opt/ai-executive -perm /022 ! -type l | head -n 3
runuser -u ai-executive -- test -r /opt/ai-executive/node_modules/next/dist/bin/next && echo "ai-executive cte kod"
runuser -u ai-executive -- test -r /opt/ai-executive/.next/BUILD_ID && echo "ai-executive cte build"
runuser -u ai-executive -- touch /opt/ai-executive/.probe 2>&1 && { echo "CHYBA: sluzba muze zapisovat do kodu"; exit 1; } || echo "zapis do kodu je odepren (spravne)"
```

**Kontrola:** `HEAD` je shodný s `OLD_HEAD`; `pnpm install` skončí bez chyby. pnpm 10 nespouští instalační skripty závislostí, pokud nejsou povolené; výpis může obsahovat řádek `Ignored build scripts: ...` (v době psaní žádná závislost skript nevyžaduje a build prošel). Pokud se objeví seznam balíčků, nahlásit jej, ale **nespouštět `pnpm approve-builds`**. `pnpm build` skončí bez chyby; příkazy `find` nic nevypíšou; `ai-executive` kód čte a nemůže do něj zapsat.
**Když selže:** `rm -rf /opt/ai-executive` (nic dalšího se nezměnilo), nahlásit důvod. Starou službu zatím nespouštět, nebo ji spustit zpět `systemctl start ai-executive`, pokud výpadek už nemá smysl prodlužovat.

### 5. Data a tajné údaje

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
test ! -e /var/lib/ai-executive -o -z "$(ls -A /var/lib/ai-executive 2>/dev/null)" || { echo "STOP: /var/lib/ai-executive neni prazdny"; exit 1; }
test ! -e /etc/ai-executive/ai-executive.env || { echo "STOP: env soubor uz existuje"; exit 1; }

install -d -o ai-executive -g ai-executive -m 0700 /var/lib/ai-executive
cp -a "$OLD_DATA/." /var/lib/ai-executive/
chown -R ai-executive:ai-executive /var/lib/ai-executive
chmod 0700 /var/lib/ai-executive
find /var/lib/ai-executive -type d -exec chmod 0700 {} +
find /var/lib/ai-executive -type f -exec chmod 0600 {} +

install -d -o root -g root -m 0755 /etc/ai-executive
install -o root -g root -m 0600 "$OLD_ENV" /etc/ai-executive/ai-executive.env
sed -i -E '/^[[:space:]]*(export[[:space:]]+)?(AI_EXECUTIVE_DATA_DIR|PORT|NODE_ENV)[[:space:]]*=/d' /etc/ai-executive/ai-executive.env

echo "== klice puvodni .env -> novy env soubor (jen nazvy)"
diff <(sed -E '/^[[:space:]]*(#|$)/d; s/=.*//' "$OLD_ENV" | sort) <(sed -E '/^[[:space:]]*(#|$)/d; s/=.*//' /etc/ai-executive/ai-executive.env | sort) || true
printf 'AI_EXECUTIVE_DATA_DIR/PORT/NODE_ENV v novem souboru: %s\n' "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?(AI_EXECUTIVE_DATA_DIR|PORT|NODE_ENV)[[:space:]]*=' /etc/ai-executive/ai-executive.env || true)"
stat -c '%a %U:%G %n' /etc/ai-executive/ai-executive.env /var/lib/ai-executive

runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$BK/fakta-nove-misto.json"
cat "$BK/fakta-nove-misto.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-nove-misto.json"
test "$(sha256sum < "$OLD_DATA/store.sqlite")" = "$(sha256sum < /var/lib/ai-executive/store.sqlite)" && echo "sha256 databaze = original"
```

**Kontrola:** `diff` klíčů ukáže nanejvýš smazané řádky `AI_EXECUTIVE_DATA_DIR`/`PORT`/`NODE_ENV` (hodnoty se nevypisují; `diff` porovnává jen názvy); počet těchto klíčů v novém souboru je `0`; vlastníci a režimy `600 root:root` a `700 ai-executive:ai-executive`; `integrity` je `ok`, `TABULKY: shodne`, shodné sha256.
**Když selže:** `rm -rf /var/lib/ai-executive /etc/ai-executive/ai-executive.env`, zjistit příčinu, zopakovat. Originály jsou nedotčené.

### 6. Instalace šablony

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
# Drop-iny, ktere meni ucet, kod, spusteni nebo data, do zalohy (ne do nove jednotky).
if [ -d /etc/systemd/system/ai-executive.service.d ]; then
  for f in /etc/systemd/system/ai-executive.service.d/*.conf; do
    [ -e "$f" ] || continue
    if [ "$(basename "$f")" = 20-security-alerts.conf ] && [ "$ALERTS" = 1 ]; then echo "ponechan: $f"; continue; fi
    if grep -qE '^[[:space:]]*(User|Group|WorkingDirectory|ExecStart|ExecStartPre|EnvironmentFile|ReadWritePaths|StateDirectory|Environment=.*DATA_DIR)' "$f"; then
      echo "presunuto do zalohy: $f"; mkdir -p "$BK/removed-dropins"; mv "$f" "$BK/removed-dropins/"
    else
      echo "NEOCEKAVANY drop-in (nemeni zadnou citlivou volbu): $f -> nahlasit, ponechan"
    fi
  done
fi
install -o root -g root -m 0644 /opt/ai-executive/deployment/ai-executive.service /etc/systemd/system/ai-executive.service
systemd-analyze verify /etc/systemd/system/ai-executive.service
systemctl daemon-reload
systemctl cat ai-executive --no-pager | grep -E '^(# /|User=|Group=|WorkingDirectory=|ExecStart=|EnvironmentFile=|ReadWritePaths=|Environment=)' | sed -E 's/((PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=).*/\1<skryto>/'
systemd-analyze security ai-executive --no-pager | tail -n 3 | tee "$BK/systemd-analyze-security.txt"
if [ "$ALERTS" = 1 ]; then
  chown -R ai-executive:hermes /var/lib/ai-executive-security/outbox
  chmod 2770 /var/lib/ai-executive-security/outbox
  stat -c '%a %U:%G %n' /var/lib/ai-executive-security/outbox
fi
```

Poznámka: drop-in, který žádnou z uvedených voleb nenastavuje, se jen nahlásí a zůstává. Doplněk se při kroku 6 nemusí instalovat znovu, jeho drop-in zůstává; `ops/security-alerts/install.sh` lze spustit později, čte `User` z `systemctl show` a vlastníka fronty nastaví na `ai-executive:hermes`, `2770`, ale také restartuje službu (proto je v tomto kroku nahrazeno přímým `chown`/`chmod`).

**Kontrola:** `systemd-analyze verify` bez chyb; `systemctl cat` ukazuje `User=ai-executive`, `WorkingDirectory=/opt/ai-executive`, `ExecStart=/usr/bin/node /opt/ai-executive/node_modules/next/dist/bin/next start --hostname 127.0.0.1`, `EnvironmentFile=/etc/ai-executive/ai-executive.env` a (jen s doplňkem) `ReadWritePaths=/var/lib/ai-executive-security/outbox`; zaznamenat skóre `systemd-analyze security` (očekává se výrazně lepší než u staré jednotky, hodnotu jen uvést do hlášení); fronta má `2770 ai-executive:hermes`.
**Když selže:** vrátit původní jednotku a drop-iny ze zálohy (krok 9) a nahlásit výstup `systemd-analyze verify`.

### 7. Spuštění

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
ss -ltn | grep -E ':3000\b' && { echo "STOP: port 3000 je obsazeny"; exit 1; } || true
START=$(date '+%F %T')
printf 'START=%q\n' "$START" >> /var/backups/ai-executive/migrace.vars
systemctl enable --now ai-executive
for i in $(seq 1 60); do
  curl -fsS -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && { echo "pripraveno po ${i}s"; break; }
  sleep 1
  [ "$i" = 60 ] && { echo "NEPRIPRAVENO"; journalctl -u ai-executive -b --since "$START" --no-pager | tail -n 30; exit 1; }
done
echo "== chyby v zurnalu od startu"
journalctl -u ai-executive -b --since "$START" --no-pager | grep -E 'EACCES|EROFS|EPERM|SQLITE_CANTOPEN|ENOENT|Error' || echo "zadne"
systemctl --no-pager --lines=0 status ai-executive | head -n 6
```

**Kontrola:** „připraveno po Ns“, v žurnálu „žádné“ (`EACCES`, `EROFS`, `SQLITE_CANTOPEN` nesmí být; pro tuto aplikaci `next start` nepotřebuje zapisovat do `/opt/ai-executive`).
**Když selže:** krok 9 (návrat zpět). Do hlášení přiložit posledních 30 řádků žurnálu.

### 8. Kontroly

```bash
set -uo pipefail
. /var/backups/ai-executive/migrace.vars
MAINPID=$(systemctl show ai-executive -p MainPID --value)
FAILS=0
chk() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "OK    $d"; else echo "SELHANI $d"; FAILS=$((FAILS+1)); fi; }
chk_not() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "SELHANI $d"; FAILS=$((FAILS+1)); else echo "OK    $d"; fi; }
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
want() { [ "$2" = "$3" ] && echo "OK    $1 ($2)" || { echo "SELHANI $1 (je $2, ma byt $3)"; FAILS=$((FAILS+1)); }; }

echo "== sluzba a ucet"
want "systemctl is-active" "$(systemctl is-active ai-executive)" active
want "systemd User" "$(systemctl show ai-executive -p User --value)" ai-executive
want "proces bezi pod" "$(ps -o user= -p "$MAINPID" | tr -d ' ')" ai-executive

echo "== izolace"
chk_not "ai-executive necte domov $OLD_HOME" runuser -u ai-executive -- ls "$OLD_HOME"
chk_not "ai-executive necte stare .data" runuser -u ai-executive -- test -r "$OLD_DATA/store.sqlite"
runuser -u ai-executive -- test -r "$OLD_ENV" && echo "INFO  stary .env je cten uctem ai-executive (domov/soubor ma siroka prava); odstrani to krok 10" || echo "OK    ai-executive necte stary .env"
want "ProtectHome: /home ve jmennem prostoru sluzby je prazdny" "$(nsenter -t "$MAINPID" -m ls -A /home | wc -l | tr -d ' ')" 0
chk_not "ProtectSystem=strict: zapis do /opt/ai-executive selze (i pro root v namespace)" nsenter -t "$MAINPID" -m sh -c 'touch /opt/ai-executive/.probe'
rm -f /opt/ai-executive/.probe  # kdyby zapis presto prosel, nesmi zustat v checkoutu (krok 11 vyzaduje cisty stav)
chk "StateDirectory je v namespace zapisovatelny" nsenter -t "$MAINPID" -m sh -c 'touch /var/lib/ai-executive/.probe && rm /var/lib/ai-executive/.probe'
echo "== poslech (ocekavano jen 127.0.0.1:3000)"; ss -ltnp | grep -E 'pid='"$MAINPID" || true
want "pocet poslechu na 3000 mimo 127.0.0.1" "$(ss -ltn | awk '$4 ~ /:3000$/ && $4 != "127.0.0.1:3000"' | wc -l | tr -d ' ')" 0

echo "== autentizacni hranice lokalne"
want "/api/store bez relace" "$(code http://127.0.0.1:3000/api/store)" 401
want "/api/auth/status" "$(code http://127.0.0.1:3000/api/auth/status)" 200
want "prihlasovaci stranka /" "$(code http://127.0.0.1:3000/)" 200
echo "== HTTPS pres Tailscale Serve (stejne tri kontroly)"
H=https://vm13861.tail412944.ts.net:8443
want "HTTPS /api/store bez relace" "$(code $H/api/store)" 401
want "HTTPS /api/auth/status" "$(code $H/api/auth/status)" 200
want "HTTPS prihlasovaci stranka /" "$(code $H/)" 200
tailscale serve status || true

echo "== integrita a pocty (po startu)"
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$BK/fakta-po-startu.json"; echo "check-data exit=$?"
cat "$BK/fakta-po-startu.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-po-startu.json" "$VOLATILE" "$IGNORED" || FAILS=$((FAILS+1))
echo "VAPID/predplatne push: $(/usr/bin/node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tables;console.log("push_subscriptions="+t.push_subscriptions+" metadata="+t.metadata+" calendar_sources="+t.calendar_sources)' "$BK/fakta-po-startu.json")"
echo "pred:                 $(/usr/bin/node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tables;console.log("push_subscriptions="+t.push_subscriptions+" metadata="+t.metadata+" calendar_sources="+t.calendar_sources)' "$BK/fakta-original.json")"

echo "== zurnal"
journalctl -u ai-executive -b --since "$START" --no-pager | grep -cE 'EACCES|EROFS|EPERM|SQLITE_CANTOPEN' || true
if [ "$ALERTS" = 1 ]; then stat -c '%a %U:%G %n' /var/lib/ai-executive-security/outbox; fi
echo "Celkem selhani: $FAILS"
```

**Kontrola (automatická část):** `Celkem selhání: 0`; `ps` a `User` ukazují `ai-executive`; poslech jen na `127.0.0.1:3000`; `/api/store` → `401`, `/api/auth/status` → `200`, přihlašovací stránka `200` lokálně i přes HTTPS; `check-data` skončí s `integrity: ok`; stabilní tabulky (`entities`, `relations`, `tombstones`, `calendar_sources`, `push_subscriptions`, `passkey_credentials` a další datové) mají stejné počty jako v `fakta-original.json`, provozní (`security_events`, `notification_deliveries`, `metadata`, `attention_*`, …) neubyly, krátkodobé (`ai_proposals`, `passkey_challenges`, `calendar_events`) se jen vypíšou jako `INFO`; v žurnálu `0` chyb přístupu; fronta bezpečnostních upozornění (jen s doplňkem) je `2770 ai-executive:hermes`.

Kontroly **vyžadující vlastníka** (požádat ho o ně a výsledek zapsat do hlášení; nelze je ověřit ze serveru):

1. **Přihlášení** v prohlížeči/PWA na `https://vm13861.tail412944.ts.net:8443` stávajícím heslem (potvrzuje shodný hash a secret; relace ze starého běhu zůstanou platné, protože secret je stejný).
2. **Push (vyžaduje vlastníka):** v Nastavení na iPhonu odeslat zkušební oznámení; musí dorazit. Počet `push_subscriptions` a `metadata` (VAPID) se nesmí změnit, jinak by předplatné přestalo platit.
3. **Kalendář (vyžaduje vlastníka):** v pohledu Kalendář vynutit obnovení; počet `calendar_sources` se nezměnil a žurnál po obnovení neobsahuje chyby stahování (`journalctl -u ai-executive --since "5 min ago" --no-pager`).
4. **Asistent (vyžaduje vlastníka, jen když `.env` obsahuje `OPENAI_API_KEY` nebo `HERMES_*`, viz klíče z kroku 1):** položit asistentovi krátký dotaz; musí odpovědět bez chyby spojení. Ověřuje, že poskytovatel AI a most Hermes jsou ze sandboxu dosažitelné (`RestrictAddressFamilies` povoluje jen IP a unixové sockety; most běžící na unixovém socketu v domově `hermesadmin` by byl skrytý `ProtectHome`).
5. **Zálohy (vyžaduje vlastníka):** v Nastavení vytvořit zálohu. Poté ověřit:

   ```bash
   ls -l --time-style=full-iso /var/lib/ai-executive/backups | tail -n 3
   stat -c '%a %U:%G %n' $(ls -t /var/lib/ai-executive/backups/* | head -n 1)
   ```

   Nový soubor má `600 ai-executive:ai-executive` a leží v `/var/lib/ai-executive/backups`, ne ve starém `.data`.

**Když selže** jakákoli automatická kontrola nebo vlastník nepotvrdí body 1–5: krok 9.

### 9. Návrat zpět

Platí kdykoli před krokem 10. Změny, které nová služba udělala od startu do návratu (nová data v UI), se v návratu **ztratí** (okno je krátké a systém se reálně nepoužívá). Pro případné obnovení se nejdřív uloží kopie nového stavu.

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
systemctl stop ai-executive || true
# Novy stav ulozit pro pripadne dohledani zmen (zustane take v /var/lib/ai-executive).
cp -a /var/lib/ai-executive "$BK/novy-stav-pred-navratem-$(date +%Y%m%d-%H%M%S)"

# Puvodni jednotka a drop-iny ze zalohy.
rm -f /etc/systemd/system/ai-executive.service
rm -rf /etc/systemd/system/ai-executive.service.d
cp -a "$BK/systemd/ai-executive.service" /etc/systemd/system/ai-executive.service
if [ -d "$BK/systemd/ai-executive.service.d" ]; then cp -a "$BK/systemd/ai-executive.service.d" /etc/systemd/system/ai-executive.service.d; fi
if [ -d "$BK/removed-dropins" ]; then mkdir -p /etc/systemd/system/ai-executive.service.d; cp -a "$BK/removed-dropins/." /etc/systemd/system/ai-executive.service.d/; fi
if [ "$ALERTS" = 1 ]; then chown -R "$OLD_USER":hermes /var/lib/ai-executive-security/outbox; chmod 2770 /var/lib/ai-executive-security/outbox; fi
systemctl daemon-reload
systemctl reset-failed ai-executive || true
systemctl cat ai-executive --no-pager | grep -E '^(User|WorkingDirectory)='
(cd "$BK" && sha256sum -c --quiet MANIFEST.sha256) && echo "zaloha je neporusena"
systemctl start ai-executive
for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && break; sleep 1; done
systemctl show ai-executive -p User --value
curl -sS -o /dev/null -w '/api/store: %{http_code}\n' http://127.0.0.1:3000/api/store
curl -sS -o /dev/null -w '/api/auth/status: %{http_code}\n' http://127.0.0.1:3000/api/auth/status
curl -sS -o /dev/null -w 'HTTPS /api/store: %{http_code}\n' --max-time 15 https://vm13861.tail412944.ts.net:8443/api/store
/usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" | tee "$BK/fakta-po-navratu.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-po-navratu.json" "$VOLATILE" "$IGNORED"
```

**Kontrola:** `User=` je původní účet, `WorkingDirectory` původní checkout, `/api/store` → `401`, `/api/auth/status` → `200`, HTTPS `401`, integrita `ok`, počty beze změny.
**Hlášení:** co selhalo (číslo kroku, výpis), že běží původní konfigurace, kde je uložen nový stav (`$BK/novy-stav-pred-navratem-*`, `/var/lib/ai-executive`). Účet `ai-executive`, `/opt/ai-executive` a `/etc/ai-executive` zůstávají nepoužité (nevadí; odstranit jen na pokyn vlastníka). Po návratu **nepokračovat** v dalším pokusu bez pokynu vlastníka.
**Když selže i návrat:** `systemctl status ai-executive`, `journalctl -u ai-executive -n 50`; originály `.data`/`.env` jsou nedotčené a zálohy v `$BK`. Zastavit a nahlásit, nic dalšího nemazat.

### 10. Úklid po úspěchu

Teprve po výslovném potvrzení vlastníka, že krok 8 včetně bodů „vyžaduje vlastníka“ prošly. Tím sdílený účet přestane mít přístup ke starým kopiím dat a tajných údajů. Po tomto kroku už krok 9 nefunguje v původní podobě (obnova by šla ze `old-home-*`).

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
test "$(systemctl show ai-executive -p User --value)" = ai-executive || { echo "STOP: sluzba nebezi pod ai-executive"; exit 1; }
OLDHOME_BK=/var/backups/ai-executive/old-home-$TS
install -d -m 0700 "$OLDHOME_BK"
mv "$OLD_DATA" "$OLDHOME_BK/data"
mv "$OLD_ENV" "$OLDHOME_BK/env"
chown -R root:root "$OLDHOME_BK"; chmod -R go-rwx "$OLDHOME_BK"
runuser -u "$OLD_USER" -- ls -A "$OLD_DIR" | grep -E '^(\.env|\.data)' && echo "CHYBA: porad tam je" || echo "stare .data a .env uz nejsou v domove"
runuser -u "$OLD_USER" -- test -r "$OLDHOME_BK/env" && echo "CHYBA: ucet cte zalohu" || echo "sdileny ucet zalohu necte"
systemctl is-active ai-executive
curl -sS -o /dev/null -w '/api/store: %{http_code}\n' http://127.0.0.1:3000/api/store
```

Starý checkout lze ponechat (už nemá tajné údaje ani data, služba ho nepoužívá) nebo na pokyn vlastníka odstranit; v hlášení uvést, co se stalo. Zálohy (`pre-account-*`, `old-home-*`) ponechat, dokud vlastník nerozhodne o retenci. Nevypisovat jejich obsah.

**Kontrola:** staré `.data` a `.env` už nejsou v domově `hermesadmin`, účet `hermesadmin` zálohu nečte, služba běží a `/api/store` → `401`.
**Když selže:** `mv` zpět z `$OLDHOME_BK`, nahlásit.

### 11. Nasazování po přechodu

Toto je nová rutina pro další verze, nahrazuje dosavadní. Spouští se jako `root`, **nikdy jako `hermesadmin`** (sdílený účet nesmí smět měnit kód, který běží s daty Lumi). Služba se při sestavování zastaví, protože `pnpm build` přepisuje `.next`, který by běžící proces používal.

```bash
set -euo pipefail
umask 022
cd /opt/ai-executive
PREV=$(git rev-parse HEAD); STAMP=$(date +%Y%m%d-%H%M%S); B=/var/backups/ai-executive/deploy-$STAMP
echo "predchozi HEAD: $PREV"
test -z "$(git status --porcelain)" || { echo "STOP: /opt/ai-executive neni cisty"; exit 1; }

# 1. Zaloha se zastavenim sluzby a kontrolou kopie
systemctl stop ai-executive
install -d -m 0700 "$B"
cp -a /var/lib/ai-executive "$B/data"
cp -a /etc/ai-executive/ai-executive.env "$B/env"
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$B/fakta-pred.json"
/usr/bin/node /opt/ai-executive/scripts/check-data.mjs "$B/data/store.sqlite" > "$B/fakta-kopie.json"
grep -q '"integrity":"ok"' "$B/fakta-kopie.json" || { echo "STOP: kopie neprosla; sluzbu spustit zpet"; systemctl start ai-executive; exit 1; }

# 2. Nova verze (jen fast-forward), zavislosti a build
git fetch origin
git merge --ff-only origin/main
pnpm install --frozen-lockfile
pnpm build
chown -R root:root /opt/ai-executive; chmod -R go-w /opt/ai-executive

# 3. Jednotka (jen pokud se sablona zmenila) a start
if ! cmp -s deployment/ai-executive.service /etc/systemd/system/ai-executive.service; then
  echo "UPOZORNENI: sablona jednotky se lisi od nainstalovane; nahlasit vlastnikovi pred jakoukoli zmenou"
fi
systemctl start ai-executive
for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && break; sleep 1; done
```

Poté stejné kontroly jako v kroku 8: služba aktivní a pod `ai-executive`; integrita a počty (`check-data` se `cmp_tables "$B/fakta-pred.json" <nove> "$VOLATILE" "$IGNORED"`; proměnné a funkci načte `. /var/backups/ai-executive/migrace.vars`); autentizační hranice (`/api/store` → `401`, `/api/auth/status` → `200`, přihlašovací stránka `200`) lokálně i přes `https://vm13861.tail412944.ts.net:8443`; žurnál bez `EACCES`/`EROFS`/`SQLITE_CANTOPEN`.

Návrat chybné verze: `systemctl stop ai-executive`, `git reset --hard "$PREV"`, `pnpm install --frozen-lockfile && pnpm build`, a pokud nová verze změnila data, obnovit `"$B/data"` do `/var/lib/ai-executive` (`ai-executive:ai-executive`, `0700`/`0600`) a znovu ověřit `check-data`; pak `systemctl start ai-executive` a kontroly z kroku 8.

Pokud `git fetch` jako root nemá přístup k `origin` (soukromý repozitář), nahlásit vlastníkovi; nikdy nevkládat token do URL ani do `/opt/ai-executive/.git/config` (je čitelný pro službu).
