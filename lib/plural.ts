// "5 záznamů", "1 claim": a count with the noun in the form the language needs. `forms` lists the forms separated by "|"
// in the order one | few | other (Czech: 1 záznam, 2-4 záznamy, 5+ záznamů, 0 záznamů) or one | other (English).
export function pluralText(language: "cs" | "en", count: number, forms: string) {
  const parts = forms.split("|");
  const category = new Intl.PluralRules(language === "cs" ? "cs" : "en").select(count);
  const form = category === "one" ? parts[0] : category === "few" && parts.length >= 3 ? parts[1] : parts[parts.length - 1];
  return `${count} ${form}`;
}
