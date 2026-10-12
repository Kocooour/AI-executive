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
- **Nikdy nečíst, nevypisovat ani nediffovat hodnoty tajných údajů.** Z `.env` se smí vypsat jen názvy klíčů (funkce `keys` níže vypisuje jen řádky tvaru `KLÍČ=…`), počty řádků a kontrolní součty.
- Původní `.data` a `.env` se do kroku 10 jen kopírují, nepřesouvají. Návrat zpět (krok 9) se na ně spoléhá.
- Při jakémkoli neočekávaném stavu **zastavit a nahlásit**, ne improvizovat. Každý krok má „Kontrolu“ (očekávaný výsledek) a „Když selže“.
- Proměnné mezi bloky drží soubor `/var/backups/ai-executive/migrace.vars` (vytvoří ho krok 1, neobsahuje tajné údaje; adresa `origin` se ukládá bez přihlašovacích údajů). Každý další blok jej načte, takže postup funguje i v oddělených shellech.

Okno: vlastník potvrdil, že přechod lze provést kdykoli (systém se ještě reálně nepoužívá). Výpadek je v řádu minut.

## Zkouška nanečisto

Privilegovaný systemd kontejner v tomto prostředí nebyl povolen, proto vznikla nejbližší bezpečná aproximace: [`deployment/rehearsal/rehearse.sh`](../deployment/rehearsal/rehearse.sh). Spouští se jako root v **jednorázovém** stroji nebo kontejneru (`pnpm install --frozen-lockfile && pnpm build`, pak `sudo deployment/rehearsal/rehearse.sh`; kód návratu je `0` jen při `RESULT: PASS`, zadaný `REHEARSAL_PREFIX` nesmí existovat, protože se na konci maže). Skript vytvoří uživatele `lumi-old` (náhrada za `hermesadmin`, domov `0750`) a `ai-executive`, vše ostatní drží pod jedním prefixem (výchozí dočasný adresář), na konci uklidí procesy, účty i prefix a vypíše `RESULT: PASS|FAIL`. Porty: `3160` (starý), `3162` (nový).

Nacvičeno (kroky 2–5, 8 a 9 upravené na prefix, bez systemd):

- stará instance pod `lumi-old` z domova s `.data` a `.env`, nasazená přes API (přihlášení, `PUT /api/store`, záloha),
- záloha s kontrolním součtem a `check-data` na kopii (včetně `.env.example` ve sledovaném kódu a klonu repozitáře cizího vlastníka jako root), kopie dat a `.env` do nových umístění se správnými vlastníky a režimy, odstranění `AI_EXECUTIVE_DATA_DIR`/`PORT`/`NODE_ENV` z env souboru,
- start nové instance pod `ai-executive` z kořenem vlastněného adresáře kódu s `AI_EXECUTIVE_DATA_DIR`, stejná čísla záznamů, `401` bez relace a `200` s relací, přihlášení stejným heslem, nová instance nečte starý domov, `.env` ani starou databázi, po sérii požadavků a vytvoření zálohy se v adresáři kódu nic nezměnilo, zálohy skončily v novém adresáři jako `0600`,
- návrat zpět: znovu start staré instance z nedotčených dat.

**Nelze nacvičit** (musí se potvrdit na serveru v kroku 8): vlastnosti, které dodává jen systemd: `ProtectSystem=strict` (zápis do `/opt` a mimo `StateDirectory` selže), mount namespace `ProtectHome=true`, parsování `EnvironmentFile` (rozdíly proti dotenv, krok 1), `StateDirectory`/`StateDirectoryMode`, `UMask=0077`, `PrivateTmp`, `CapabilityBoundingSet=`, `NoNewPrivileges`, `Restart=`, sandbox skutečného `systemd-analyze security` skóre a Tailscale Serve.

## Postup přechodu pro Codex

### 0. Předpoklady a stop podmínky

Pokračovat jen pokud platí všechno z toho:

- Fáze A je nasazená a produkce běží (`systemctl is-active ai-executive` = `active`).
- Stávající checkout už obsahuje release s tímto postupem (soubory `scripts/check-data.mjs`, `lib/data-dir.ts`, `deployment/ai-executive.service`). Pokud ne, nejdřív ho nasaďte dosavadním způsobem (záloha, `git merge --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, restart, kontroly) a až poté přejděte sem. Přechod tak mění jen místo běhu, ne verzi aplikace. **Před nasazením tohoto release proveďte kontrolu `AI_EXECUTIVE_DATA_DIR` níže.**
- Node.js je na `/usr/bin/node`, není pod `/home` a umí `node:sqlite` bez přepínačů (**vyžadováno ≥ 22.13**; starší 22.x ho mají jen za příznakem). Je dostupný `pnpm` ≥ 10 a `git`.
- Je dost místa (alespoň 3× velikost `.data` a 2 GB pro kód a závislosti).
- Stav je takový, jak postup popisuje. Cokoli neočekávaného (jiný účet, jiný port, další `EnvironmentFile`, další `.env.*` soubory, více jednotek) znamená **zastavit a nahlásit**.

```bash
set -euo pipefail
test "$(id -u)" -eq 0 || { echo "STOP: spustit jako root"; exit 1; }
systemctl is-active ai-executive
command -v pnpm git
test -x /usr/bin/node || { echo "STOP: /usr/bin/node neexistuje (sablona by nesla spustit)"; exit 1; }
echo "node: /usr/bin/node -> $(readlink -f /usr/bin/node)"
case "$(readlink -f /usr/bin/node)" in /home/*|/root/*) echo "STOP: node lezi v domovskem adresari (ProtectHome ho skryje)"; exit 1;; esac
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)) { console.error("STOP: node "+process.version+" < 22.13"); process.exit(1); } import("node:sqlite").then(()=>console.log("node",process.version,"node:sqlite OK"))'
pnpm --version
df -h / /var /opt | cat

# Kontrola AI_EXECUTIVE_DATA_DIR (hodnota je cesta, ne tajny udaj, smi se vypsat).
# Relativni hodnota ve vydane verzi zpusobi, ze `next build` selze a `next start` bezi, ale vsechny pozadavky na data koncí chybou 500.
OLD_DIR=$(systemctl show ai-executive -p WorkingDirectory --value)
FOUND=0
unit_value=$(systemctl show ai-executive -p Environment --value | tr ' ' '\n' | sed -n 's/^AI_EXECUTIVE_DATA_DIR=//p' | tail -n1)
[ -z "$unit_value" ] || { echo "jednotka/drop-in: $unit_value"; FOUND=1; case "$unit_value" in /*) ;; *) echo "STOP: relativni hodnota v jednotce"; exit 1;; esac; }
for f in "$OLD_DIR"/.env "$OLD_DIR"/.env.*; do
  [ -f "$f" ] || continue; [ "$(basename "$f")" = .env.example ] && continue
  v=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?AI_EXECUTIVE_DATA_DIR[[:space:]]*=[[:space:]]*//p' "$f" | tail -n1 | tr -d "\"'")
  [ -z "$v" ] || { echo "$f: $v"; FOUND=1; case "$v" in /*) ;; *) echo "STOP: relativni hodnota v $f"; exit 1;; esac; }
done
[ "$FOUND" = 1 ] || echo "AI_EXECUTIVE_DATA_DIR neni nastavena (pouzije se <cwd>/.data)"
```

**Kontrola:** `active`, `node: /usr/bin/node ...`, `node:sqlite OK`, verze pnpm 10.x, volné místo; `AI_EXECUTIVE_DATA_DIR` buď není nastavena, nebo je absolutní.
**Když selže:** zastavit, nahlásit přesný výpis. Node mimo `/usr/bin` nebo chybějící pnpm neřešit na vlastní pěst (úprava šablony či instalace nástrojů je rozhodnutí vlastníka). Pokud je `AI_EXECUTIVE_DATA_DIR` **relativní**: nedeployovat tento release. Nejprve ve staré konfiguraci (stejné místo, kde je dnes nastavena: `.env`, jednotka nebo drop-in) nastavit **absolutní ekvivalent** (`<WorkingDirectory>/<relativní hodnota>`), službu restartovat, ověřit, že běží a čte stejná data (`check-data`, přihlášení), a teprve potom pokračovat.

### 1. Inventura (jen čtení)

Zapisuje se jen do `/var/backups/ai-executive` (soubor s proměnnými, výpis počtů) a nic dalšího se nemění. Všechny výpisy z `.env` obsahují **jen názvy klíčů a počty řádků**.

```bash
set -euo pipefail
umask 077
install -d -m 0700 /var/backups/ai-executive
VARS=/var/backups/ai-executive/migrace.vars
# Nazvy klicu (jen radky tvaru KLIC=...) a pocet ostatnich neprazdnych nekomentovanych radku (napr. telo viceradkove hodnoty).
keys() { grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=.*//' | sort || true; }
other_lines() { grep -vcE '^[[:space:]]*(#|$)|^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" || true; }

OLD_USER=$(systemctl show ai-executive -p User --value)
OLD_DIR=$(systemctl show ai-executive -p WorkingDirectory --value)
FRAGMENT=$(systemctl show ai-executive -p FragmentPath --value)
test -n "$OLD_USER" -a "$OLD_USER" != root -a "$OLD_USER" != ai-executive || { echo "STOP: neocekavany User='$OLD_USER'"; exit 1; }
test -d "$OLD_DIR" || { echo "STOP: WorkingDirectory '$OLD_DIR' neexistuje"; exit 1; }
test "$FRAGMENT" = /etc/systemd/system/ai-executive.service || { echo "STOP: jednotka je jinde: $FRAGMENT"; exit 1; }
OLD_HOME=$(getent passwd "$OLD_USER" | cut -d: -f6)
OLD_ENV="$OLD_DIR/.env"
test -f "$OLD_ENV" || { echo "STOP: $OLD_ENV neexistuje"; exit 1; }
# Zaloha (cp -a) i uklid pracuji se souborem samotnym; symlink by zalohoval jen odkaz a skutecny soubor
# s tajnymi udaji by zustal na cili odkazu.
[ ! -L "$OLD_ENV" ] && [ "$(readlink -f "$OLD_ENV")" = "$OLD_ENV" ] || { echo "STOP: $OLD_ENV je symlink nebo vede pres symlink; nahlasit"; exit 1; }
OLD_ENV_MODE=$(stat -c %a "$OLD_ENV")

# Jednotka se vypisuje bez hodnot promennych a bez argumentu spousteni (mohou obsahovat tajne udaje
# s jakymkoli nazvem); nazvy klicu a cesta programu se vypisuji zvlast.
echo "== unit vcetne drop-inu (bez Environment= a bez argumentu Exec*)"
systemctl cat ai-executive --no-pager | grep -vE '^[[:space:]]*Environment=' | sed -E 's/^([[:space:]]*Exec[A-Za-z]*=[^[:space:]]*).*/\1 <argumenty skryty>/'
echo "== EnvironmentFiles (ocekavano prazdne)"; systemctl show ai-executive -p EnvironmentFiles --value
echo "== drop-iny"; systemctl show ai-executive -p DropInPaths --value | tr ' ' '\n'
echo "== klice Environment= v jednotce"; systemctl show ai-executive -p Environment --value | grep -oE '(^| )[A-Za-z_][A-Za-z0-9_]*=' | tr -d ' =' | sort || true
echo "== ExecStart (jen program)"; systemctl show ai-executive -p ExecStart --value | grep -oE 'path=[^ ;]*' | head -n1
echo "== porty"; ss -ltnp | grep -E ':(3000|8443)\b' || true
echo "== tailscale serve"; tailscale serve status || true
OTHER=$(other_lines "$OLD_ENV"); echo "ostatni neprazdne radky .env (nejsou KLIC=...): $OTHER"
# Radek pokracovani viceradkove hodnoty muze vypadat jako KLIC=... (napr. base64 s "=="): nazvy se vypisi jen bez takovych radku.
if [ "$OTHER" = 0 ]; then echo "== klice v .env"; keys "$OLD_ENV"; else echo "== klice v .env: nevypisuji (soubor ma radky mimo KLIC=hodnota)"; fi
echo "== .env* v checkoutu (povoleno presne .env a .env.example)"
STRAY=$(ls -A "$OLD_DIR" | grep -E '^\.env' | grep -vxF -e .env -e .env.example || true); echo "${STRAY:-zadne dalsi}"
for KEY in AI_EXECUTIVE_DATA_DIR PORT NODE_ENV; do printf '%s: %s radku v .env\n' "$KEY" "$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$KEY[[:space:]]*=" "$OLD_ENV" || true)"; done
echo "== rozdily systemd EnvironmentFile vs dotenv (jen pocty radku)"
printf 'radky s "$": %s\nradky s prefixem export: %s\nradky s uvozovkami: %s\nradky s " #" (komentar na radku): %s\n' \
  "$(grep -c '\$' "$OLD_ENV" || true)" "$(grep -cE '^[[:space:]]*export[[:space:]]' "$OLD_ENV" || true)" \
  "$(grep -cE "=[[:space:]]*[\"']" "$OLD_ENV" || true)" "$(grep -cE '[[:space:]]#' "$OLD_ENV" || true)"
stat -c '%a %U:%G %n' "$OLD_ENV" "$OLD_DIR" "$OLD_HOME"
[ "$OTHER" = 0 ] || { echo "STOP: .env obsahuje radky mimo KLIC=hodnota (viceradkove hodnoty); systemd EnvironmentFile je cte jinak nez dotenv"; exit 1; }
[ "$(grep -c '\$' "$OLD_ENV" || true)" = 0 ] && [ "$(grep -cE '^[[:space:]]*export[[:space:]]' "$OLD_ENV" || true)" = 0 ] \
  || { echo "STOP: .env obsahuje \$ nebo prefix export; systemd by hodnotu cetl jinak nez dotenv (napr. stary hash hesla s \$ je treba nejdriv vygenerovat znovu ve formatu scrypt:...)"; exit 1; }
# "#" v hodnote: dotenv (Next.js) hodnotu bez uvozovek na "#" utne, systemd ji necha celou. Projde jen "#"
# uvnitr hodnoty cele v uvozovkach (KLIC="a#b" nebo KLIC='a#b', za uvozovkou uz nic).
HASHES=$({ grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.*#' "$OLD_ENV" || true; } \
  | { grep -vE "^[^=]*=[[:space:]]*(\"[^\"]*\"|'[^']*')[[:space:]]*\$" || true; } | wc -l)
# Dalsi zapisy, ktere dotenv cte jinak nez systemd: hodnota ve zpetnych apostrofech (dotenv je odstrani)
# a jakekoli zpetne lomitko (dotenv v uvozovkach rozvine \n, systemd ma pro escapy vlastni pravidla).
ESCAPES=$({ grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*(`|.*\\)' "$OLD_ENV" || true; } | wc -l)
[ "$ESCAPES" = 0 ] || { echo "STOP: .env ma $ESCAPES radku s hodnotou ve zpetnych apostrofech nebo se zpetnym lomitkem; dotenv a systemd je ctou jinak. Nahlasit."; exit 1; }
DUP=$(keys "$OLD_ENV" | uniq -d | wc -l)
[ "$DUP" = 0 ] || { echo "STOP: .env obsahuje $DUP klicu zapsanych vicekrat (dotenv bere posledni zapis); nahlasit"; exit 1; }
[ "$HASHES" = 0 ] \
  || { echo "STOP: .env ma $HASHES radku s \"#\" v hodnote bez uvozovek nebo s komentarem za hodnotou; dotenv a systemd je ctou jinak. Vlastnik musi hodnotu dat do uvozovek nebo komentar presunout na samostatny radek."; exit 1; }
[ -z "$STRAY" ] || { echo "STOP: dalsi .env* soubory v checkoutu"; exit 1; }
printf 'OLD_USER=%q\nOLD_DIR=%q\nOLD_HOME=%q\nOLD_ENV=%q\nOLD_ENV_MODE=%q\n' "$OLD_USER" "$OLD_DIR" "$OLD_HOME" "$OLD_ENV" "$OLD_ENV_MODE" > "$VARS"
chmod 0600 "$VARS"
```

Druhý blok navazuje na soubor proměnných z prvního, spusťte je proto v tomto pořadí. Určete umístění dat a uložte proměnné. Hodnota `AI_EXECUTIVE_DATA_DIR` je cesta, ne tajný údaj, smí se vypsat. `git` běží jako root nad repozitářem jiného účtu, proto funkce `gitsafe` používá **dočasný globální config** (`safe.directory = *`); přepínač `-c safe.directory=...` u `git clone` nestačí (ověřeno na git 2.43: „dubious ownership“).

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
gitsafe() { local f rc; f=$(mktemp); printf '[safe]\n\tdirectory = *\n' > "$f"; GIT_CONFIG_GLOBAL="$f" git "$@"; rc=$?; rm -f "$f"; return $rc; }
OLD_DATA=$(systemctl show ai-executive -p Environment --value | tr ' ' '\n' | sed -n 's/^AI_EXECUTIVE_DATA_DIR=//p' | tail -n1)
[ -n "$OLD_DATA" ] || OLD_DATA=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?AI_EXECUTIVE_DATA_DIR[[:space:]]*=[[:space:]]*//p' "$OLD_ENV" | tail -n1 | tr -d "\"'")
[ -n "$OLD_DATA" ] || OLD_DATA="$OLD_DIR/.data"
case "$OLD_DATA" in /*) ;; *) OLD_DATA="$OLD_DIR/$OLD_DATA";; esac
echo "OLD_DATA=$OLD_DATA"; ls -la --time-style=+%F "$OLD_DATA" | awk '{print $1,$3,$4,$5,$6,$7}'
# Zaloha i uklid pracuji s adresarem samotnym: symlink (i v nadrazene ceste) by zalohoval jen odkaz.
[ "$(readlink -f "$OLD_DATA")" = "$OLD_DATA" ] || { echo "STOP: $OLD_DATA je symlink nebo vede pres symlink ($(readlink -f "$OLD_DATA")); nahlasit"; exit 1; }
test -f "$OLD_DATA/store.sqlite" || { echo "STOP: store.sqlite nenalezen"; exit 1; }
# Ani uvnitr dat nesmi byt symlinky (cp -a je kopiruje jako odkazy, manifest je vynecha a check-data by
# sel po odkazu k puvodnim datum).
LINKS=$(find "$OLD_DATA" -type l | wc -l)
[ "$LINKS" = 0 ] || { echo "STOP: v $OLD_DATA je $LINKS symlinku; nahlasit"; find "$OLD_DATA" -type l -printf '  %P\n'; exit 1; }
test -f "$OLD_DIR/scripts/check-data.mjs" || { echo "STOP: stavajici checkout nema scripts/check-data.mjs (viz krok 0)"; exit 1; }

echo "== doplnek bezpecnostnich upozorneni"
if [ -f /etc/systemd/system/ai-executive.service.d/20-security-alerts.conf ]; then ALERTS=1; ls -ld /var/lib/ai-executive-security/outbox; else ALERTS=0; echo "neni nainstalovan"; fi
# Fronta upozorneni se prenasi jen ve tvaru, ktery instaluje ops/security-alerts/install.sh (drop-in s presne
# touto cestou). Jinde nastavena (.env, hlavni jednotka, jiny drop-in, jina cesta) by se po prechodu tise zmenila.
OUTBOX_UNIT=$(systemctl show ai-executive -p Environment --value | tr ' ' '\n' | sed -n 's/^AI_EXECUTIVE_SECURITY_OUTBOX_DIR=//p' | head -n1)
[ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?AI_EXECUTIVE_SECURITY_OUTBOX_DIR[[:space:]]*=' "$OLD_ENV" || true)" = 0 ] \
  || { echo "STOP: AI_EXECUTIVE_SECURITY_OUTBOX_DIR je v .env; nahlasit (nova jednotka by ji nesmela zapisovat)"; exit 1; }
if [ "$ALERTS" = 1 ]; then
  [ "$OUTBOX_UNIT" = /var/lib/ai-executive-security/outbox ] || { echo "STOP: fronta upozorneni ma necekanou cestu '$OUTBOX_UNIT'; nahlasit"; exit 1; }
  [ "$(grep -l AI_EXECUTIVE_SECURITY_OUTBOX_DIR /etc/systemd/system/ai-executive.service /etc/systemd/system/ai-executive.service.d/*.conf 2>/dev/null)" = /etc/systemd/system/ai-executive.service.d/20-security-alerts.conf ] \
    || { echo "STOP: AI_EXECUTIVE_SECURITY_OUTBOX_DIR je nastavena i mimo 20-security-alerts.conf; nahlasit"; exit 1; }
else
  [ -z "$OUTBOX_UNIT" ] || { echo "STOP: AI_EXECUTIVE_SECURITY_OUTBOX_DIR je nastavena bez doplnku bezpecnostnich upozorneni; nahlasit"; exit 1; }
fi
echo "== jine jednotky/cron odkazujici na stary adresar (jen nazvy souboru; samotna jednotka ai-executive.service tu vzdy je)"
grep -rIl -e "$OLD_DIR" -e "$OLD_DATA" /etc/systemd /etc/cron* /var/spool/cron 2>/dev/null || true

echo "== pocty zaznamu (zive, jen ke cteni; jako vlastnik dat, aby -wal/-shm nevznikly jako root)"
runuser -u "$OLD_USER" -- /usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" | tee /var/backups/ai-executive/inventura-pred.json

TS=$(date +%Y%m%d-%H%M%S)
OLD_HEAD=$(gitsafe -C "$OLD_DIR" rev-parse HEAD)
OLD_BRANCH=$(gitsafe -C "$OLD_DIR" branch --show-current)
RAW_ORIGIN=$(gitsafe -C "$OLD_DIR" remote get-url origin)
case "$RAW_ORIGIN" in *://*@*) ORIGIN_HAS_CREDS=1;; *) ORIGIN_HAS_CREDS=0;; esac
ORIGIN_URL=$(printf '%s' "$RAW_ORIGIN" | sed -E 's#//[^@/]*@#//#')   # do souboru se uklada vzdy bez prihlasovacich udaju
unset RAW_ORIGIN
echo "HEAD=$OLD_HEAD vetev=$OLD_BRANCH origin=$ORIGIN_URL (prihlasovaci udaje v origin: $ORIGIN_HAS_CREDS)"
gitsafe -C "$OLD_DIR" status --porcelain | head -n 20
{
  printf 'OLD_USER=%q\nOLD_DIR=%q\nOLD_HOME=%q\nOLD_ENV=%q\nOLD_ENV_MODE=%q\nOLD_DATA=%q\nALERTS=%q\nTS=%q\nBK=%q\nOLD_HEAD=%q\nOLD_BRANCH=%q\nORIGIN_URL=%q\nORIGIN_HAS_CREDS=%q\n' \
    "$OLD_USER" "$OLD_DIR" "$OLD_HOME" "$OLD_ENV" "$OLD_ENV_MODE" "$OLD_DATA" "$ALERTS" "$TS" "/var/backups/ai-executive/pre-account-$TS" "$OLD_HEAD" "$OLD_BRANCH" "$ORIGIN_URL" "$ORIGIN_HAS_CREDS"
  cat <<'FUNCS'
# git jako root nad repozitarem jineho uctu: docasny globalni config (-c safe.directory u clone nestaci).
gitsafe() { local f rc; f=$(mktemp); printf '[safe]\n\tdirectory = *\n' > "$f"; GIT_CONFIG_GLOBAL="$f" git "$@"; rc=$?; rm -f "$f"; return $rc; }
# Nazvy klicu v env souboru (jen radky KLIC=...) a pocet ostatnich radku; hodnoty se nikdy nevypisuji.
keys() { grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=.*//' | sort || true; }
other_lines() { grep -vcE '^[[:space:]]*(#|$)|^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" || true; }
# cmp_tables <pred.json> <po.json> [volatile,tables] [ignored,tables]: stabilni tabulky musi byt stejne,
# volatilni nesmi ubyt, ignorovane (zaznamy s kratkou platnosti) a tabulky nove v novejsim release
# (chybi v "pred") se jen vypisou.
cmp_tables() {
  /usr/bin/node -e '
    const fs = require("fs"); const [a, b, volatile = "", ignored = ""] = process.argv.slice(1);
    const x = JSON.parse(fs.readFileSync(a, "utf8")).tables, y = JSON.parse(fs.readFileSync(b, "utf8")).tables;
    const soft = new Set(volatile.split(",").filter(Boolean)), skip = new Set(ignored.split(",").filter(Boolean)); let bad = 0;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (skip.has(name)) { console.log("INFO", name, x[name], "->", y[name]); continue; }
      if (x[name] === undefined) { console.log("INFO nova tabulka", name, y[name]); continue; }
      const ok = soft.has(name) ? (y[name] ?? 0) >= x[name] : x[name] === y[name];
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
echo "Ulozeno: /var/backups/ai-executive/migrace.vars (bez tajnych udaju; origin bez prihlasovacich udaju)"
```

**Kontrola (zastavit a nahlásit při odchylce):**

- `User` je jeden obyčejný účet (`hermesadmin`), `FragmentPath` je `/etc/systemd/system/ai-executive.service`.
- `EnvironmentFiles` je prázdné. V `.env` je to, co Next.js načítá z `cwd`. V checkoutu jsou **právě** `.env` a (sledovaný v gitu) `.env.example`; jakýkoli jiný `.env*` soubor (`.env.local`, `.env.production`) Next načítá také a postup by ho nepřenesl, blok se zastaví.
- Klíče `Environment=` v jednotce jsou jen z množiny `NODE_ENV`, `PORT`, `AI_EXECUTIVE_DATA_DIR`, `AI_EXECUTIVE_SECURITY_OUTBOX_DIR`. Jiné klíče by se musely přenést do env souboru; to je rozhodnutí k nahlášení. `AI_EXECUTIVE_SECURITY_OUTBOX_DIR` se přenáší jen v podobě, kterou instaluje doplněk (`20-security-alerts.conf` s cestou `/var/lib/ai-executive-security/outbox`); jinak blok sám zastaví.
- Port je `3000` na `127.0.0.1` a `tailscale serve status` ukazuje `https://vm13861.tail412944.ts.net:8443` → `http://127.0.0.1:3000`.
- „Ostatní neprázdné řádky `.env`“ je `0`. Nenulový počet znamená víceřádkovou hodnotu (např. PEM klíč), kterou systemd `EnvironmentFile` nečte stejně jako dotenv: **zastavit a nahlásit**, hodnotu nevypisovat.
- Řádky `.env` s `$`, prefixem `export`, `#` v hodnotě bez uvozovek nebo komentářem za hodnotou: **systemd `EnvironmentFile` se liší od dotenv, který používá Next.js**. systemd neexpanduje `$VAR`, prefix `export` neakceptuje a `#` v hodnotě bere jako její součást, kdežto dotenv hodnotu bez uvozovek na `#` utne. Ve všech těchto případech blok **sám zastaví** (hodnota by se po přechodu jinak interpretovala, např. heslový hash nebo secret); `#` uvnitř hodnoty celé v uvozovkách je v pořádku. Počet řádků s uvozovkami jen nahlásit; hodnoty nevypisovat. Hash hesla v aktuálním formátu `scrypt:<sůl>:<hash>` je bezpečný.
- Seznam „jiné jednotky/cron“ vždy obsahuje samotnou jednotku `ai-executive.service`; zajímají nás **další** soubory.
- `check-data` vypíše `"integrity":"ok"` a počty tabulek (zapsané do `inventura-pred.json`; slouží jen jako informace, závazný základ se pořídí po zastavení v kroku 2).
- `git status --porcelain` je prázdné (čistý checkout).

**Když selže:** nic se zatím nezměnilo, jen vznikl soubor s proměnnými. Nahlásit a skončit.

### 2. Záloha a ověření

Zastaví službu (konzistentní kopie včetně případných `-wal`/`-shm`), zkopíruje data, `.env` a jednotku s drop-iny do zálohy a ověří kopii.

Co je skutečná kontrola: **počty záznamů v tabulkách** (`check-data` je čte přes SQLite, tedy včetně obsahu `-wal`) a **manifest záloh** (`sha256` všech souborů). Samotný `sha256` hlavního souboru `store.sqlite` nic nedokazuje, protože při režimu WAL mohou čerstvá data ležet v `-wal`. `-shm` je sdílený index paměti, ne data, a `check-data` ho při otevření mění, proto je z manifestu vyloučen.

```bash
set -Eeuo pipefail
# Kroky 2–5 meni jen nova umisteni; pri chybe nebo preruseni (Ctrl-C, ztracene SSH) se puvodni sluzba spusti zpet.
trap 'rc=$?; trap - ERR INT TERM HUP; echo "CHYBA nebo preruseni (kod $rc) -> spoustim puvodni sluzbu"; systemctl start ai-executive; exit $rc' ERR INT TERM HUP
umask 077
. /var/backups/ai-executive/migrace.vars
systemctl stop ai-executive
systemctl is-active ai-executive && { echo "STOP: sluzba se nezastavila"; exit 1; } || true
install -d -m 0700 "$BK" "$BK/systemd"

echo "== soubory dat pred kopii"; ls -l "$OLD_DATA" | awk '{print $1,$3,$4,$5,$9}'
cp -a "$OLD_DATA" "$BK/data"
cp -a "$OLD_ENV" "$BK/env"
cp -a /etc/systemd/system/ai-executive.service "$BK/systemd/"
if [ -d /etc/systemd/system/ai-executive.service.d ]; then cp -a /etc/systemd/system/ai-executive.service.d "$BK/systemd/"; fi
# Obsah kopie proti originalu (krome -wal/-shm, jejich data overi pocty zaznamu nize).
diff -rq -x '*-wal' -x '*-shm' "$OLD_DATA" "$BK/data" && echo "kopie dat = original (bez -wal/-shm)"
find "$BK" -type d -exec chmod 0700 {} +; find "$BK" -type f -exec chmod 0600 {} +
chown -R root:root "$BK"
(cd "$BK" && find . -type f ! -name MANIFEST.sha256 ! -name '*-shm' -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
(cd "$BK" && sha256sum -c --quiet MANIFEST.sha256) && echo "Manifest OK ($(wc -l < "$BK/MANIFEST.sha256") souboru)"

# Original cte vlastnik dat (jinak by v jeho .data vznikly soubory -wal/-shm vlastnene rootem); kopii cte root.
runuser -u "$OLD_USER" -- /usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" > "$BK/fakta-original.json"
/usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$BK/data/store.sqlite" > "$BK/fakta-kopie.json"
cat "$BK/fakta-kopie.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-kopie.json"
```

**Kontrola:** `kopie dat = original`, `Manifest OK`, kopie má `"integrity":"ok"`, nenulový počet tabulek a `TABULKY: shodne`. `fakta-original.json` je závazný základ pro všechna další porovnání.
**Když selže:** trap službu spustí zpět sám (i při přerušení). Ověřit `systemctl is-active ai-executive` a `/api/auth/status`, nahlásit. Nic dalšího nedělat, originály jsou nedotčené.

### 3. Účet

```bash
set -Eeuo pipefail
# Kroky 2–5 meni jen nova umisteni; pri chybe nebo preruseni (Ctrl-C, ztracene SSH) se puvodni sluzba spusti zpet.
trap 'rc=$?; trap - ERR INT TERM HUP; echo "CHYBA nebo preruseni (kod $rc) -> spoustim puvodni sluzbu"; systemctl start ai-executive; exit $rc' ERR INT TERM HUP
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

Klonuje se lokálně ze stávajícího checkoutu (stejný commit, bez síťových přihlašovacích údajů), pak se nastaví skutečný `origin` pro budoucí nasazování. Klon jako root z repozitáře jiného účtu bez `safe.directory` selže s „dubious ownership“; `gitsafe` (krok 1) to řeší dočasným globálním configem.

```bash
set -Eeuo pipefail
# Kroky 2–5 meni jen nova umisteni; pri chybe nebo preruseni (Ctrl-C, ztracene SSH) se puvodni sluzba spusti zpet.
trap 'rc=$?; trap - ERR INT TERM HUP; echo "CHYBA nebo preruseni (kod $rc) -> spoustim puvodni sluzbu"; systemctl start ai-executive; exit $rc' ERR INT TERM HUP
umask 022
. /var/backups/ai-executive/migrace.vars
test ! -e /opt/ai-executive || { echo "STOP: /opt/ai-executive uz existuje"; exit 1; }
[ "$ORIGIN_HAS_CREDS" = 0 ] || { echo "STOP: origin stareho checkoutu obsahuje prihlasovaci udaje; nahlasit"; exit 1; }
test -n "$OLD_BRANCH" || { echo "STOP: stary checkout nema vetev (detached HEAD)"; exit 1; }

gitsafe clone --no-hardlinks "$OLD_DIR" /opt/ai-executive
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
# Povolen je jen sledovany .env.example; jakykoli jiny .env* nebo .data je chyba.
STRAY=$(ls -A /opt/ai-executive | grep -E '^\.(env|data)' | grep -vxF .env.example || true)
[ -z "$STRAY" ] && echo "zadny .env* (krome .env.example) ani .data v /opt/ai-executive" || { echo "CHYBA: v kodu je: $STRAY"; exit 1; }
find /opt/ai-executive -not -user root | head -n 3
find /opt/ai-executive -perm /022 ! -type l | head -n 3
runuser -u ai-executive -- test -r /opt/ai-executive/node_modules/next/dist/bin/next && echo "ai-executive cte kod"
runuser -u ai-executive -- test -r /opt/ai-executive/.next/BUILD_ID && echo "ai-executive cte build"
if runuser -u ai-executive -- touch /opt/ai-executive/.probe 2>/dev/null; then rm -f /opt/ai-executive/.probe; echo "CHYBA: sluzba muze zapisovat do kodu"; exit 1; else echo "zapis do kodu je odepren (spravne)"; fi
```

**Kontrola:** `HEAD` je shodný s `OLD_HEAD`; `pnpm install` skončí bez chyby. pnpm 10 nespouští instalační skripty závislostí, pokud nejsou povolené; výpis může obsahovat řádek `Ignored build scripts: ...` (v době psaní žádná závislost skript nevyžaduje a build prošel). Pokud se objeví seznam balíčků, nahlásit jej, ale **nespouštět `pnpm approve-builds`**. `pnpm build` skončí bez chyby; příkazy `find` nic nevypíšou; `ai-executive` kód čte a nemůže do něj zapsat.
**Když selže:** trap spustí původní službu zpět. Pak `rm -rf /opt/ai-executive` (nic dalšího se nezměnilo) a nahlásit důvod; další pokus začíná krokem 2.

### 5. Data a tajné údaje

```bash
set -Eeuo pipefail
# Kroky 2–5 meni jen nova umisteni; pri chybe nebo preruseni (Ctrl-C, ztracene SSH) se puvodni sluzba spusti zpet.
trap 'rc=$?; trap - ERR INT TERM HUP; echo "CHYBA nebo preruseni (kod $rc) -> spoustim puvodni sluzbu"; systemctl start ai-executive; exit $rc' ERR INT TERM HUP
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
diff <(keys "$OLD_ENV") <(keys /etc/ai-executive/ai-executive.env) || true
echo "ostatni neprazdne radky noveho souboru: $(other_lines /etc/ai-executive/ai-executive.env)"
printf 'AI_EXECUTIVE_DATA_DIR/PORT/NODE_ENV v novem souboru: %s\n' "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?(AI_EXECUTIVE_DATA_DIR|PORT|NODE_ENV)[[:space:]]*=' /etc/ai-executive/ai-executive.env || true)"
stat -c '%a %U:%G %n' /etc/ai-executive/ai-executive.env /var/lib/ai-executive

diff -rq -x '*-wal' -x '*-shm' "$BK/data" /var/lib/ai-executive && echo "nove misto = zaloha (bez -wal/-shm)"
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$BK/fakta-nove-misto.json"
cat "$BK/fakta-nove-misto.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-nove-misto.json"
```

**Kontrola:** `diff` klíčů ukáže nanejvýš smazané řádky `AI_EXECUTIVE_DATA_DIR`/`PORT`/`NODE_ENV` (jen názvy); počet těchto klíčů v novém souboru je `0`; vlastníci a režimy `600 root:root` a `700 ai-executive:ai-executive`; `nove misto = zaloha`; `integrity` je `ok` a `TABULKY: shodne` (počty jsou rozhodující kontrola, viz krok 2).
**Když selže:** trap spustí původní službu zpět. Pak `rm -rf /var/lib/ai-executive /etc/ai-executive/ai-executive.env`, zjistit příčinu a nahlásit; další pokus začíná krokem 2. Originály jsou nedotčené.

### 6. Instalace šablony

```bash
set -euo pipefail
# Trap z kroku 2–5 (spusteni puvodni sluzby) tu uz neplati: po daemon-reload je nactena nova jednotka.
# Pri selhani tohoto kroku plati "Kdyz selze" nize (krok 9), ne automaticky start.
trap - ERR INT TERM HUP
. /var/backups/ai-executive/migrace.vars
# Nova jednotka nesmi zdedit nic ze stareho nastaveni: kazdy drop-in krome doplnku bezpecnostnich
# upozorneni jde do zalohy (i ten, ktery jen vypina hardening, napr. ProtectSystem=false).
# Doplnek smi obsahovat jen sve dve volby; cokoli dalsiho znamena STOP.
if [ -d /etc/systemd/system/ai-executive.service.d ]; then
  for f in /etc/systemd/system/ai-executive.service.d/*.conf; do
    [ -e "$f" ] || continue
    if [ "$(basename "$f")" = 20-security-alerts.conf ] && [ "$ALERTS" = 1 ]; then
      EXTRA=$({ grep -vE '^[[:space:]]*(#|$|\[Service\]$|Environment=AI_EXECUTIVE_SECURITY_OUTBOX_DIR=/var/lib/ai-executive-security/outbox$|ReadWritePaths=/var/lib/ai-executive-security/outbox$)' "$f" || true; } | wc -l)
      [ "$EXTRA" = 0 ] || { echo "STOP: $f obsahuje dalsi volby ($EXTRA radku); nahlasit"; exit 1; }
      echo "ponechan (jen fronta upozorneni): $f"; continue
    fi
    echo "presunuto do zalohy: $f"; mkdir -p "$BK/removed-dropins"; mv "$f" "$BK/removed-dropins/"
  done
fi
install -o root -g root -m 0644 /opt/ai-executive/deployment/ai-executive.service /etc/systemd/system/ai-executive.service
systemd-analyze verify /etc/systemd/system/ai-executive.service
systemctl daemon-reload
systemctl cat ai-executive --no-pager | grep -E '^(# /(etc|run|usr|lib)/|User=|Group=|WorkingDirectory=|ExecStart=|EnvironmentFile=|ReadWritePaths=|Environment=)' | sed -E 's/((PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=).*/\1<skryto>/'
systemd-analyze security ai-executive --no-pager | tail -n 3 | tee "$BK/systemd-analyze-security.txt"
if [ "$ALERTS" = 1 ]; then
  chown -R ai-executive:hermes /var/lib/ai-executive-security/outbox
  chmod 2770 /var/lib/ai-executive-security/outbox
  stat -c '%a %U:%G %n' /var/lib/ai-executive-security/outbox
fi
```

Poznámka: všechny staré drop-iny kromě `20-security-alerts.conf` (a ten jen s jeho dvěma volbami) jdou do zálohy, aby nová jednotka nezdědila změněný účet, start ani vypnutý hardening. Seznam přesunutých souborů patří do hlášení; návrat (krok 9) je vrací zpět. Doplněk se při kroku 6 nemusí instalovat znovu, jeho drop-in zůstává; `ops/security-alerts/install.sh` lze spustit později, čte `User` z `systemctl show` a vlastníka fronty nastaví na `ai-executive:hermes`, `2770`, ale také restartuje službu (proto je v tomto kroku nahrazeno přímým `chown`/`chmod`).

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
  curl -fs -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && { echo "pripraveno po ${i}s"; break; }
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

Zahrnují i potvrzení vlastností, které lze ověřit jen pod systemd (`ProtectSystem`, `ProtectHome`, `StateDirectory`, `UMask`, `ProtectProc`, `RestrictNamespaces`, `RestrictRealtime`, `SystemCallArchitectures`, `LimitCORE`).

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
want "LimitCORE=0" "$(systemctl show ai-executive -p LimitCORE --value)" 0
want "ProtectProc=invisible" "$(systemctl show ai-executive -p ProtectProc --value)" invisible
want "NoNewPrivileges" "$(systemctl show ai-executive -p NoNewPrivileges --value)" yes
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
chk "Tailscale Serve miri na 127.0.0.1:3000" bash -c "tailscale serve status 2>&1 | grep -q '127.0.0.1:3000'"

echo "== integrita a pocty (po startu)"
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$BK/fakta-po-startu.json"; rc=$?
want "check-data exit" "$rc" 0
cat "$BK/fakta-po-startu.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-po-startu.json" "$VOLATILE" "$IGNORED" || FAILS=$((FAILS+1))
echo "VAPID/predplatne push: $(/usr/bin/node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tables;console.log("push_subscriptions="+t.push_subscriptions+" metadata="+t.metadata+" calendar_sources="+t.calendar_sources)' "$BK/fakta-po-startu.json")"
echo "pred:                 $(/usr/bin/node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tables;console.log("push_subscriptions="+t.push_subscriptions+" metadata="+t.metadata+" calendar_sources="+t.calendar_sources)' "$BK/fakta-original.json")"

echo "== zurnal"
want "chyby pristupu v zurnalu od startu" "$(journalctl -u ai-executive -b --since "$START" --no-pager | grep -cE 'EACCES|EROFS|EPERM|SQLITE_CANTOPEN' || true)" 0
if [ "$ALERTS" = 1 ]; then want "fronta bezpecnostnich upozorneni" "$(stat -c '%a %U:%G' /var/lib/ai-executive-security/outbox)" "2770 ai-executive:hermes"; fi

echo "== podklady pro hlaseni"
echo "systemd-analyze security: $(tail -n 1 "$BK/systemd-analyze-security.txt")"
echo "zalohy: $BK"; ls -d /var/backups/ai-executive/* | sed 's/^/  /'
echo "Celkem selhani: $FAILS"
[ "$FAILS" -eq 0 ]
```

**Kontrola (automatická část):** poslední řádek `Celkem selhani: 0` a blok skončí s kódem `0` (při jakémkoli selhání je kód nenulový); `ps` a `User` ukazují `ai-executive`; poslech jen na `127.0.0.1:3000`; Tailscale Serve míří na `127.0.0.1:3000`; `/api/store` → `401`, `/api/auth/status` → `200`, přihlašovací stránka `200` lokálně i přes HTTPS; `check-data` skončí s `integrity: ok`; stabilní tabulky (`entities`, `relations`, `tombstones`, `calendar_sources`, `push_subscriptions`, `passkey_credentials` a další datové) mají stejné počty jako v `fakta-original.json`, provozní (`security_events`, `notification_deliveries`, `metadata`, `attention_*`, …) neubyly, krátkodobé (`ai_proposals`, `passkey_challenges`, `calendar_events`) a nové tabulky novějšího release se jen vypíšou jako `INFO`; v žurnálu `0` chyb přístupu; fronta bezpečnostních upozornění (jen s doplňkem) je `2770 ai-executive:hermes`.

Automatickou část spusťte **dřív**, než vlastník začne s kontrolami níže: změny, které při nich udělá (přihlášení, záloha, nový úkol), by jinak porovnání počtů ohlásilo jako rozdíl.

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

**Hlášení po úspěšném kroku 8** (vždy, i bez problémů): výsledek automatických kontrol (`Celkem selhani`), skóre `systemd-analyze security` (původní a nové, pokud bylo zjištěno), výsledky pěti kontrol vlastníka (potvrzeno / nepotvrzeno / čeká), cesty ponechaných záloh (`$BK`, soubor `migrace.vars`, `pnpm-install.log`), otevřené body (zejména: krok 10 čeká na potvrzení vlastníka; stará kopie `.data` a `.env` zatím zůstává ve sdíleném domově; případné nahlášené odchylky v `.env`/drop-inech; zda má root přístup k `origin` pro krok 11).

### 9. Návrat zpět

Platí kdykoli před krokem 10 (po kroku 10 viz „Obnova ze zálohy“ níže). Změny, které nová služba udělala od startu do návratu (nová data v UI), se v návratu **ztratí** (okno je krátké a systém se reálně nepoužívá). Pro případné obnovení se nejdřív uloží kopie nového stavu. Postup má tři části: 9.1 zastavit a vrátit jednotku, 9.2 (jen když je potřeba obnovit data ze zálohy) a 9.3 spustit a ověřit.

**9.1 Zastavení a původní jednotka:**

```bash
set -Eeuo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
# Dokud se nezacne vracet jednotka, plati nova konfigurace: selhani nebo preruseni ji spusti zpet.
trap 'rc=$?; trap - ERR INT TERM HUP; echo "CHYBA nebo preruseni (kod $rc) pred vracenim jednotky -> spoustim sluzbu (novou konfiguraci) zpet"; systemctl start ai-executive; exit $rc' ERR INT TERM HUP
systemctl stop ai-executive || true
# Novy stav ulozit pro pripadne dohledani zmen (zustane take v /var/lib/ai-executive).
cp -a /var/lib/ai-executive "$BK/novy-stav-pred-navratem-$(date +%Y%m%d-%H%M%S)"
# Od teto chvile se meni jednotka; pri selhani dal plati "Kdyz selze i navrat" (nic nespoustet naslepo).
trap - ERR INT TERM HUP

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
```

**9.2 Obnova ze zálohy** (nutná jen když původní `.data`/`.env` byly po kroku 10 přesunuty nebo poškozeny; jinak přeskočit). Zdroj `SRC` je `$BK` (záloha z kroku 2) nebo, po kroku 10, `/var/backups/ai-executive/old-home-$TS`; v obou je podadresář `data` a soubor `env`:

```bash
set -euo pipefail
umask 077
. /var/backups/ai-executive/migrace.vars
SRC=$BK            # po kroku 10 pripadne: SRC=/var/backups/ai-executive/old-home-$TS
test -f "$SRC/data/store.sqlite" -a -f "$SRC/env" || { echo "STOP: $SRC neobsahuje data/ a env"; exit 1; }
systemctl is-active ai-executive && { echo "STOP: nejdriv zastavit sluzbu"; exit 1; } || true
OLD_GROUP=$(id -gn "$OLD_USER")
if [ -e "$OLD_DATA" ]; then mv "$OLD_DATA" "$OLD_DATA.pred-obnovou-$(date +%Y%m%d-%H%M%S)"; fi
cp -a "$SRC/data" "$OLD_DATA"
chown -R "$OLD_USER:$OLD_GROUP" "$OLD_DATA"
chmod 0700 "$OLD_DATA"; find "$OLD_DATA" -type d -exec chmod 0700 {} +; find "$OLD_DATA" -type f -exec chmod 0600 {} +
if [ -e "$OLD_ENV" ]; then mv "$OLD_ENV" "$OLD_ENV.pred-obnovou-$(date +%Y%m%d-%H%M%S)"; fi
install -o "$OLD_USER" -g "$OLD_GROUP" -m "$OLD_ENV_MODE" "$SRC/env" "$OLD_ENV"
stat -c '%a %U:%G %n' "$OLD_DATA" "$OLD_ENV"
runuser -u "$OLD_USER" -- /usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" | tee "$BK/fakta-po-obnove.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-po-obnove.json" "$VOLATILE" "$IGNORED"
```

(Soubory `*.pred-obnovou-*` obsahují tajné údaje nebo data; nemazat bez pokynu vlastníka, jen je nahlásit.)

**9.3 Spuštění a ověření:**

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
# check-data a pripadne starsi spusteni jako root mohly vytvorit -wal/-shm vlastnene rootem; stary uzivatel je musi vlastnit.
for f in "$OLD_DATA"/store.sqlite-*; do [ -e "$f" ] && chown --reference="$OLD_DATA/store.sqlite" "$f"; done
systemctl start ai-executive
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:3000/manifest.webmanifest || { echo "SELHANI: puvodni sluzba po navratu neodpovida"; exit 1; }
test "$(systemctl show ai-executive -p User --value)" = "$OLD_USER" || { echo "SELHANI: sluzba nebezi pod $OLD_USER"; exit 1; }
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
want() { [ "$2" = "$3" ] && echo "OK    $1 ($2)" || { echo "SELHANI $1 (je $2, ma byt $3)"; exit 1; }; }
want "/api/store bez relace" "$(code http://127.0.0.1:3000/api/store)" 401
want "/api/auth/status" "$(code http://127.0.0.1:3000/api/auth/status)" 200
want "HTTPS /api/store bez relace" "$(code https://vm13861.tail412944.ts.net:8443/api/store)" 401
runuser -u "$OLD_USER" -- /usr/bin/node "$OLD_DIR/scripts/check-data.mjs" "$OLD_DATA/store.sqlite" | tee "$BK/fakta-po-navratu.json"
cmp_tables "$BK/fakta-original.json" "$BK/fakta-po-navratu.json" "$VOLATILE" "$IGNORED"
```

**Kontrola:** `User=` je původní účet, `WorkingDirectory` původní checkout, `/api/store` → `401`, `/api/auth/status` → `200`, HTTPS `401`, integrita `ok`, počty beze změny.
**Hlášení:** co selhalo (číslo kroku, výpis), že běží původní konfigurace, kde je uložen nový stav (`$BK/novy-stav-pred-navratem-*`, `/var/lib/ai-executive`), cesty záloh a zda byla použita obnova 9.2. Po návratu **nepokračovat** v dalším pokusu bez pokynu vlastníka.
**Když selže i návrat:** `systemctl status ai-executive`, `journalctl -u ai-executive -n 50`; originály `.data`/`.env` jsou nedotčené (nebo je obnoví 9.2) a zálohy v `$BK`. Zastavit a nahlásit, nic dalšího nemazat.

**Úklid po návratu (pro pozdější nový pokus; jen na pokyn vlastníka).** Nový stav je nejdřív uložen v 9.1 (`$BK/novy-stav-pred-navratem-*`); teprve pak lze odstranit nepoužité artefakty:

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
test "$(systemctl show ai-executive -p User --value)" = "$OLD_USER" || { echo "STOP: sluzba nebezi pod puvodnim uctem"; exit 1; }
ls -d "$BK"/novy-stav-pred-navratem-* >/dev/null || { echo "STOP: novy stav neni ulozen"; exit 1; }
rm -rf /opt/ai-executive /var/lib/ai-executive /etc/ai-executive
# Ucet ai-executive lze ponechat (je nepouzivany); odstrani ho jen explicitni: userdel ai-executive
```

### 10. Úklid po úspěchu

Teprve po výslovném potvrzení vlastníka, že krok 8 včetně bodů „vyžaduje vlastníka“ prošly. Tím sdílený účet přestane mít přístup ke starým kopiím dat a tajných údajů. Po tomto kroku se návrat dělá přes obnovu 9.2 se zdrojem `old-home-*`.

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
# V checkoutu smi zustat jen sledovany .env.example; .env a .data nikoli.
LEFT=$(runuser -u "$OLD_USER" -- ls -A "$OLD_DIR" | grep -E '^\.(env|data)' | grep -vxF .env.example || true)
[ -z "$LEFT" ] || { echo "CHYBA: v checkoutu porad je: $LEFT"; exit 1; }
[ ! -e "$OLD_DATA" ] || { echo "CHYBA: puvodni data $OLD_DATA porad existuji"; exit 1; }
echo "stare .data a .env uz nejsou v domove"
if runuser -u "$OLD_USER" -- test -r "$OLDHOME_BK/env"; then echo "CHYBA: sdileny ucet cte zalohu"; exit 1; fi
echo "sdileny ucet zalohu necte"
systemctl is-active ai-executive
curl -sS -o /dev/null -w '/api/store: %{http_code}\n' http://127.0.0.1:3000/api/store
echo "== podklady pro hlaseni"
echo "zalohy:"; ls -d /var/backups/ai-executive/* | sed 's/^/  /'
echo "systemd-analyze security: $(tail -n 1 "$BK/systemd-analyze-security.txt")"
```

Starý checkout lze ponechat (už nemá tajné údaje ani data, služba ho nepoužívá) nebo na pokyn vlastníka odstranit. Zálohy (`pre-account-*`, `old-home-*`) ponechat, dokud vlastník nerozhodne o retenci. Nevypisovat jejich obsah.

**Kontrola:** staré `.data` a `.env` už nejsou v domově `hermesadmin` (zůstává jen `.env.example`), účet `hermesadmin` zálohu nečte, služba běží a `/api/store` → `401`.
**Když selže:** `mv` zpět z `$OLDHOME_BK`, nahlásit.
**Hlášení po kroku 10:** potvrzení vlastníka (kdy a čím), že staré kopie jsou v `old-home-$TS` (root `0700`), cesty všech ponechaných záloh a jejich velikost (`du -sh`), skóre `systemd-analyze security`, co se stalo se starým checkoutem a otevřené body (rozhodnutí o retenci záloh, přístup roota k `origin` pro krok 11, případné odchylky nahlášené dříve).

### 11. Nasazování po přechodu

Toto je nová rutina pro další verze, nahrazuje dosavadní. Spouští se jako `root`, **nikdy jako `hermesadmin`** (sdílený účet nesmí smět měnit kód, který běží s daty Lumi). Služba se při sestavování zastaví, protože `pnpm build` přepisuje `.next`, který by běžící proces používal. Ještě před zastavením služby blok ověří, že je co nasadit, že jde o fast-forward a že nová verze nemění šablonu jednotky (změnu jednotky je nutné nainstalovat a ověřit zvlášť podle kroků 6 a 8, nikdy ne mimochodem). Pokud cokoli po zastavení selže nebo je blok přerušen (Ctrl-C, ukončení, ztracené SSH spojení), trap službu nenechá potichu zastavenou: dokud se v `/opt/ai-executive` nic nezměnilo, spustí ji zpět; jakmile začal merge, instalace nebo build (i bez změny commitu může být `node_modules` nebo `.next` napůl přepsané), službu zastaví a vypíše postup, který předchozí verzi znovu sestaví. Totéž platí, když nová verze po startu do 60 s neodpovídá. Blok spouštějte v `tmux`, aby přerušené spojení neukončilo ani výpis postupu návratu.

```bash
set -Eeuo pipefail
umask 022
. /var/backups/ai-executive/migrace.vars
cd /opt/ai-executive
PREV=$(git rev-parse HEAD); STAMP=$(date +%Y%m%d-%H%M%S); B=/var/backups/ai-executive/deploy-$STAMP
echo "predchozi HEAD: $PREV"
test -z "$(git status --porcelain)" || { echo "STOP: /opt/ai-executive neni cisty"; exit 1; }

# 0. Pred zastavenim sluzby: je co nasadit, jde to fast-forwardem a nemeni se jednotka?
git fetch origin
# Nasazuje se vetev, ze ktere produkce bezi (ulozena v kroku 1), ne natvrdo main.
NEXT=$(git rev-parse "origin/$OLD_BRANCH")
[ "$NEXT" != "$PREV" ] || { echo "Nic k nasazeni (origin/$OLD_BRANCH = $PREV)."; exit 0; }
git merge-base --is-ancestor "$PREV" "$NEXT" || { echo "STOP: origin/$OLD_BRANCH neni fast-forward od $PREV; nahlasit"; exit 1; }
if ! git diff --quiet "$PREV" "$NEXT" -- deployment/ai-executive.service; then
  echo "STOP: nova verze meni deployment/ai-executive.service. Jednotku je treba nainstalovat a overit"
  echo "      (krok 6 a kontroly kroku 8) jako samostatny krok s vlastnikem; sluzba bezi dal beze zmeny."
  exit 1
fi

# Od prvni zmeny v /opt/ai-executive (merge, node_modules, .next) uz stara verze bez noveho sestaveni nepobezi.
CHANGED=0
on_error() {
  local rc=$?; trap - ERR INT TERM HUP; set +e
  echo "CHYBA (kod $rc) u prikazu: $BASH_COMMAND"
  if [ "$CHANGED" = 0 ]; then
    echo "Kod ani sestaveni se nezmenily -> spoustim sluzbu zpet."; systemctl start ai-executive
  else
    # Nova ani napul prepsana verze nesmi bezet, kdyz merge, instalace, build, start nebo kontrola dat selhaly.
    systemctl stop ai-executive
    echo "Kod nebo sestaveni se zmenily, sluzba je ZASTAVENA. Navrat (sestavi znovu predchozi verzi $PREV):"
    echo "  cd /opt/ai-executive && git reset --hard $PREV && pnpm install --frozen-lockfile && pnpm build"
    echo "  chown -R root:root /opt/ai-executive; chmod -R go-w /opt/ai-executive"
    echo "  find /var/lib/ai-executive -mindepth 1 -delete && cp -a $B/data/. /var/lib/ai-executive/   # jen pokud nova verze zmenila data"
    echo "  chown -R ai-executive:ai-executive /var/lib/ai-executive; systemctl start ai-executive"
  fi
  exit $rc
}
# Take preruseni (Ctrl-C, ukonceni, ztracene SSH spojeni) nesmi nechat sluzbu potichu zastavenou.
trap on_error ERR INT TERM HUP

# 1. Zaloha se zastavenim sluzby a kontrolou kopie
systemctl stop ai-executive
install -d -m 0700 "$B"
cp -a /var/lib/ai-executive "$B/data"
cp -a /etc/ai-executive/ai-executive.env "$B/env"
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$B/fakta-pred.json"
/usr/bin/node /opt/ai-executive/scripts/check-data.mjs "$B/data/store.sqlite" > "$B/fakta-kopie.json"
cmp_tables "$B/fakta-pred.json" "$B/fakta-kopie.json"   # nenulovy navrat spusti trap: kopie neprosla

# 2. Nova verze (jen fast-forward na overeny commit), zavislosti a build
CHANGED=1
git merge --ff-only "$NEXT"
pnpm install --frozen-lockfile
pnpm build
chown -R root:root /opt/ai-executive; chmod -R go-w /opt/ai-executive

# 3. Start a kontrola
systemctl start ai-executive
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:3000/manifest.webmanifest && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:3000/manifest.webmanifest || { echo "NEPRIPRAVENO: nova verze neodpovida"; false; }   # spusti trap
# Trap zustava aktivni i pro kontrolu dat po startu: poskozena data nebo chybejici zaznamy novou verzi zastavi.
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite > "$B/fakta-po.json"
cmp_tables "$B/fakta-pred.json" "$B/fakta-po.json" "$VOLATILE" "$IGNORED"
trap - ERR INT TERM HUP
echo "Nasazeno: $PREV -> $(git rev-parse HEAD); zaloha $B"
```

Poté stejné kontroly jako v kroku 8 (bez části pro vlastníka): služba aktivní a pod `ai-executive`; autentizační hranice (`/api/store` → `401`, `/api/auth/status` → `200`, přihlašovací stránka `200`) lokálně i přes `https://vm13861.tail412944.ts.net:8443`; žurnál bez `EACCES`/`EROFS`/`SQLITE_CANTOPEN`. Tabulky, které chybějí v záloze (nové v novém release), `cmp_tables` hlásí jen jako `INFO nova tabulka`.

Návrat chybné verze (po úspěšném startu nebo selhání kontrol):

```bash
set -euo pipefail
. /var/backups/ai-executive/migrace.vars
systemctl stop ai-executive
cd /opt/ai-executive && git reset --hard "$PREV" && pnpm install --frozen-lockfile && pnpm build
chown -R root:root /opt/ai-executive; chmod -R go-w /opt/ai-executive
# Jen pokud nova verze zmenila data: vyprazdnit stav (vcetne starych -wal/-shm) a vratit zalohu.
find /var/lib/ai-executive -mindepth 1 -delete
cp -a "$B/data/." /var/lib/ai-executive/
chown -R ai-executive:ai-executive /var/lib/ai-executive; chmod 0700 /var/lib/ai-executive
find /var/lib/ai-executive -type d -exec chmod 0700 {} +; find /var/lib/ai-executive -type f -exec chmod 0600 {} +
runuser -u ai-executive -- /usr/bin/node /opt/ai-executive/scripts/check-data.mjs /var/lib/ai-executive/store.sqlite
systemctl start ai-executive
```

(`PREV` a `B` si v novém shellu nastavte z výpisu předchozího běhu: `PREV=<predchozi HEAD>`, `B=/var/backups/ai-executive/deploy-<STAMP>`.) Potom opakujte kontroly z kroku 8.

Pokud `git fetch` jako root nemá přístup k `origin` (soukromý repozitář), nahlásit vlastníkovi; nikdy nevkládat token do URL ani do `/opt/ai-executive/.git/config` (je čitelný pro službu).
