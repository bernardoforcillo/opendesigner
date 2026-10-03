# Negozio

<!-- Esportato da opendesigner (opendesigner export): README del documento "Negozio" (shop). NON modificare a mano:
rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design. -->

Progetto React + TypeScript + Tailwind v4 generato dal design con `opendesigner export`.

## Come si avvia

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # controllo dei tipi + build di produzione
npx playwright install chromium   # solo la prima volta
npm test         # i test e2e generati dai flussi (playwright test)
```

## Come il design diventa codice

- Ogni **schermata** (frame di primo livello) è un componente in `src/screens/<Nome>.tsx`; `src/App.tsx` ne monta le rotte (`meta["code.route"]` del frame, altrimenti lo slug del nome). La schermata iniziale del flusso è montata anche su `/`.
- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); tutto il resto è posizionato in modo assoluto (`absolute left-[..] top-[..]`) dentro il contenitore, con le coordinate del design. `hug` -> `fit-content`.
- Riempimenti, tratti (interno/centro/esterno -> anelli di `box-shadow`), ombre, sfocature, rotazione, ritaglio, testo e vettori seguono **ciò che disegna il canvas dell'editor** (primo riempimento, prima ombra, prima sfocatura).
- Le **immagini** sono copiate in `public/assets/<hash>.<ext>`; se mancano compare il segnaposto del canvas.
- Ogni elemento porta `data-node-id="<id del nodo>"`: è il legame fra il design e il codice.
- Le **istanze** dei componenti sono espanse inline (non c'è ancora l'estrazione in componenti React).
- Le schermate hanno dimensione fissa (niente responsive).

## Flussi e test

Per ogni transizione l'elemento che la innesca (`elementId`) è cliccabile (`onClick` -> `navigate(...)`, `role="button"`, `aria-label` = etichetta, `data-testid` dal meta `test.id`). Le transizioni senza elemento sono pulsanti visivamente nascosti in un `<nav>` trasparente (1px, in alto a sinistra). Le righe `// flow: <id>`, `// guard:` e `// effect:` indicano la transizione del design.

`tests/flows.spec.ts` è prodotto da `opendesigner flow tests` e percorre tutti i percorsi dei flussi con Playwright.

## Schermate

| Componente | Rotta | Nodo del design |
|---|---|---|
| `Login` | `/login` | `login` (Login) |
| `Home` | `/home` | `home` (Home) |
| `Dettaglio` | `/dettaglio` | `detail` (Dettaglio) |

## Rigenerare

```sh
opendesigner export -doc shop -target react -out . -force
```

I file generati non vanno modificati a mano: la prossima esportazione li sovrascrive. Per far evolvere il progetto a mano, esporta una volta e da lì in poi lavora sul codice (la rigenerazione non fa merge).
