import type { IconName } from "../ui/ds/Icon";
import { builtToOps, DocBuilder, PALETTE, SCREEN_W } from "./builder";
import type { BuiltTemplate, IdGen } from "./builder";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// IL CATALOGO DEI TEMPLATE. Ognuno è un punto di partenza REALE: schermate
// mobile 390x844 con interfaccia plausibile (titoli, campi, bottoni), un flusso
// già collegato, e su ogni hotspot `test.id` + su ogni schermata `code.route`,
// così il prototipo si gioca subito e il codice/Playwright esportati servono.
//
// Tutte le funzioni sono pure: lo stesso template, con lo stesso generatore di
// id, produce gli stessi nodi (i test lo sfruttano).

export interface Template {
  id: string;
  name: string;
  /** Una riga: cosa contiene. */
  tagline: string;
  icon: IconName;
  /** Il nome con cui nasce il documento. */
  docName: string;
  build: (pageId: string, newId: IdGen) => BuiltTemplate;
}

const W = SCREEN_W;
const PAD = 24;
const CW = W - 2 * PAD; // larghezza del contenuto

// ---------------------------------------------------------------------------
// Vuoto
// ---------------------------------------------------------------------------
const blank: Template = {
  id: "blank", name: "Vuoto", tagline: "Una tavola bianca: disegni tu.", icon: "plus", docName: "Senza titolo",
  build: () => ({ nodes: [], flows: [], transitions: [] }),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
const onboarding: Template = {
  id: "onboarding", name: "Onboarding", tagline: "Benvenuto, scelta, fatto: 3 schermate collegate.", icon: "sparkle", docName: "Onboarding",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const welcome = b.screen("Benvenuto", 0, 0, { route: "/benvenuto" });
    welcome.circle(W / 2 - 90, 150, 180, PALETTE.accentSoft, "Illustrazione");
    welcome.circle(W / 2 - 52, 188, 104, PALETTE.accent, "Illustrazione — nucleo");
    welcome.text("Benvenuto in Aurora", PAD, 396, CW, { size: 28, weight: "700", align: "center", name: "Titolo" });
    welcome.text("Organizza il lavoro in un posto solo, in meno di un minuto.", 40, 444, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Sottotitolo" });
    const start = welcome.button("Inizia", PAD, 676, CW, "onb-start");
    welcome.button("Ho già un account", PAD, 740, CW, "onb-login", "link");

    const choose = b.screen("Scegli", 1, 0, { route: "/scegli" });
    choose.text("Cosa ti interessa?", PAD, 96, CW, { size: 26, weight: "700", name: "Titolo" });
    choose.text("Personalizziamo l'app per te. Puoi cambiare idea dopo.", PAD, 136, CW, { size: 15, color: PALETTE.muted, h: 40, name: "Sottotitolo" });
    choose.row("Design", "Interfacce e prototipi", PAD, 210, CW, "onb-opt-design");
    choose.row("Sviluppo", "Codice e componenti", PAD, 290, CW, "onb-opt-dev");
    choose.row("Prodotto", "Roadmap e priorità", PAD, 370, CW, "onb-opt-product");
    const next = choose.button("Continua", PAD, 676, CW, "onb-next");
    const back = choose.button("Indietro", PAD, 740, CW, "onb-back", "link");

    const done = b.screen("Fatto", 2, 0, { route: "/fatto", kind: "end" });
    done.badge(W / 2, 220, 140, PALETTE.ok, "✓");
    done.text("Tutto pronto", PAD, 396, CW, { size: 28, weight: "700", align: "center", name: "Titolo" });
    done.text("Il tuo spazio è configurato. Puoi iniziare a lavorare.", 40, 444, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Sottotitolo" });
    done.button("Vai all'app", PAD, 676, CW, "onb-finish");

    const f = b.flow("Onboarding", welcome.id, "Dal primo avvio all'app configurata.");
    b.link(f, welcome.id, choose.id, { label: "Inizia", elementId: start });
    b.link(f, choose.id, done.id, { label: "Continua", elementId: next });
    b.link(f, choose.id, welcome.id, { label: "Indietro", trigger: "back", elementId: back });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Login & registrazione
// ---------------------------------------------------------------------------
const auth: Template = {
  id: "auth", name: "Login e registrazione", tagline: "Accedi, registrati, recupera, dashboard: con condizioni.", icon: "lock", docName: "Login e registrazione",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const login = b.screen("Accedi", 0, 0, { route: "/login" });
    login.text("Bentornato", PAD, 120, CW, { size: 30, weight: "700", name: "Titolo" });
    login.text("Accedi per continuare.", PAD, 166, CW, { size: 16, color: PALETTE.muted, name: "Sottotitolo" });
    login.input("Email", "nome@azienda.it", PAD, 240, CW, "login-email");
    login.input("Password", "••••••••", PAD, 330, CW, "login-password");
    const forgot = login.button("Password dimenticata?", PAD, 410, CW, "login-forgot", "link", 32);
    const submit = login.button("Accedi", PAD, 470, CW, "login-submit");
    login.text("Non hai un account?", PAD, 760, CW, { size: 14, color: PALETTE.muted, align: "center", name: "Invito" });
    const toSignup = login.button("Registrati", PAD, 784, CW, "login-signup", "link", 32);

    const signup = b.screen("Registrati", 1, 0, { route: "/registrati" });
    signup.text("Crea il tuo account", PAD, 120, CW, { size: 30, weight: "700", name: "Titolo" });
    signup.text("Bastano pochi secondi.", PAD, 166, CW, { size: 16, color: PALETTE.muted, name: "Sottotitolo" });
    signup.input("Nome", "Il tuo nome", PAD, 220, CW, "signup-name");
    signup.input("Email", "nome@azienda.it", PAD, 310, CW, "signup-email");
    signup.input("Password", "Almeno 8 caratteri", PAD, 400, CW, "signup-password");
    const create = signup.button("Crea account", PAD, 500, CW, "signup-submit");
    signup.text("Hai già un account?", PAD, 760, CW, { size: 14, color: PALETTE.muted, align: "center", name: "Invito" });
    const toLogin = signup.button("Accedi", PAD, 784, CW, "signup-login", "link", 32);

    const recovery = b.screen("Recupero password", 2, 0, { route: "/recupero" });
    recovery.text("Recupera la password", PAD, 120, CW, { size: 30, weight: "700", name: "Titolo" });
    recovery.text("Ti mandiamo un link per sceglierne una nuova.", PAD, 166, CW, { size: 16, color: PALETTE.muted, h: 44, name: "Sottotitolo" });
    recovery.input("Email", "nome@azienda.it", PAD, 250, CW, "recovery-email");
    const send = recovery.button("Invia il link", PAD, 350, CW, "recovery-submit");
    const recBack = recovery.button("Torna al login", PAD, 414, CW, "recovery-back", "link", 32);

    const dash = b.screen("Dashboard", 3, 0, { route: "/app" });
    dash.header("Dashboard");
    dash.text("Ciao, Giulia", PAD, 124, CW, { size: 26, weight: "700", name: "Saluto" });
    dash.stat("Attività aperte", "12", PAD, 176, (CW - 12) / 2);
    dash.stat("Completate", "38", PAD + (CW - 12) / 2 + 12, 176, (CW - 12) / 2);
    dash.row("Revisione design", "Scadenza domani", PAD, 288, CW, "dash-row-1");
    dash.row("Rilascio 2.4", "In corso", PAD, 368, CW, "dash-row-2");
    const logout = dash.button("Esci", PAD, 740, CW, "dash-logout", "secondary");

    const f = b.flow("Accesso", login.id, "Login, registrazione e recupero password fino alla dashboard.");
    b.link(f, login.id, dash.id, { label: "Accedi", trigger: "submit", elementId: submit, guard: "credenziali valide", effect: "crea la sessione" });
    b.link(f, login.id, signup.id, { label: "Registrati", elementId: toSignup });
    b.link(f, login.id, recovery.id, { label: "Password dimenticata?", elementId: forgot });
    b.link(f, signup.id, dash.id, { label: "Crea account", trigger: "submit", elementId: create, guard: "dati validi", effect: "crea l'utente e la sessione" });
    b.link(f, signup.id, login.id, { label: "Accedi", elementId: toLogin });
    b.link(f, recovery.id, login.id, { label: "Invia il link", trigger: "submit", elementId: send, guard: "email registrata", effect: "invia l'email di recupero" });
    b.link(f, recovery.id, login.id, { label: "Torna al login", elementId: recBack });
    b.link(f, dash.id, login.id, { label: "Esci", elementId: logout, effect: "chiude la sessione" });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
const checkout: Template = {
  id: "checkout", name: "Checkout", tagline: "Carrello, spedizione, pagamento, conferma + esito.", icon: "download", docName: "Checkout",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const cart = b.screen("Carrello", 0, 0, { route: "/carrello" });
    cart.header("Carrello");
    cart.row("Sneakers Aria", "Taglia 42 · 1 pz · €89,00", PAD, 120, CW, "cart-item-1", 72);
    cart.row("Zaino Urban", "Grigio · 1 pz · €59,00", PAD, 204, CW, "cart-item-2", 72);
    cart.box(PAD, 560, CW, 1, { fill: PALETTE.line, name: "Filo totale" });
    cart.text("Totale", PAD, 580, 120, { size: 16, color: PALETTE.muted, name: "Etichetta totale" });
    cart.text("€148,00", W - PAD - 160, 574, 160, { size: 24, weight: "700", align: "right", name: "Totale" });
    const toShip = cart.button("Procedi alla spedizione", PAD, 700, CW, "cart-checkout");

    const ship = b.screen("Spedizione", 1, 0, { route: "/spedizione" });
    ship.header("Spedizione");
    ship.input("Nome e cognome", "Mario Rossi", PAD, 120, CW, "ship-name");
    ship.input("Indirizzo", "Via Roma 1", PAD, 210, CW, "ship-address");
    ship.input("CAP", "00100", PAD, 300, (CW - 12) / 2, "ship-zip");
    ship.input("Città", "Roma", PAD + (CW - 12) / 2 + 12, 300, (CW - 12) / 2, "ship-city");
    const toPay = ship.button("Continua al pagamento", PAD, 700, CW, "ship-next");
    const shipBack = ship.button("Indietro", PAD, 760, CW, "ship-back", "link", 32);

    const pay = b.screen("Pagamento", 2, 0, { route: "/pagamento" });
    pay.header("Pagamento");
    pay.input("Numero carta", "1234 5678 9012 3456", PAD, 120, CW, "pay-card");
    pay.input("Scadenza", "MM/AA", PAD, 210, (CW - 12) / 2, "pay-exp");
    pay.input("CVV", "123", PAD + (CW - 12) / 2 + 12, 210, (CW - 12) / 2, "pay-cvv");
    pay.text("Totale da pagare: €148,00", PAD, 330, CW, { size: 15, color: PALETTE.muted, name: "Riepilogo" });
    const payNow = pay.button("Paga ora", PAD, 700, CW, "pay-submit");
    const payBack = pay.button("Indietro", PAD, 760, CW, "pay-back", "link", 32);

    // Una DECISIONE non è una schermata vera: un riquadro basso che nel
    // prototipo si attraversa da solo secondo le condizioni (`flow.kind`).
    const outcome = b.screen("Pagamento riuscito?", 3, 0, { route: "/pagamento/esito", kind: "decision", h: 300, bg: PALETTE.bgSoft });
    outcome.text("Pagamento riuscito?", PAD, 110, CW, { size: 24, weight: "700", align: "center", name: "Titolo" });
    outcome.text("Il circuito di pagamento risponde con un esito.", 40, 156, W - 80, { size: 15, color: PALETTE.muted, align: "center", h: 40, name: "Sottotitolo" });

    const done = b.screen("Conferma", 4, 0, { route: "/ordine/conferma", kind: "end" });
    done.badge(W / 2, 200, 140, PALETTE.ok, "✓");
    done.text("Ordine confermato", PAD, 376, CW, { size: 28, weight: "700", align: "center", name: "Titolo" });
    done.text("Ti abbiamo mandato la ricevuta via email.", 40, 424, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Sottotitolo" });
    done.button("Torna al negozio", PAD, 700, CW, "done-home");

    const f = b.flow("Acquisto", cart.id, "Dal carrello alla conferma dell'ordine.");
    b.link(f, cart.id, ship.id, { label: "Procedi alla spedizione", elementId: toShip });
    b.link(f, ship.id, pay.id, { label: "Continua al pagamento", elementId: toPay, guard: "indirizzo valido" });
    b.link(f, ship.id, cart.id, { label: "Indietro", trigger: "back", elementId: shipBack });
    b.link(f, pay.id, outcome.id, { label: "Paga ora", trigger: "submit", elementId: payNow, effect: "addebita la carta" });
    b.link(f, pay.id, ship.id, { label: "Indietro", trigger: "back", elementId: payBack });
    b.link(f, outcome.id, done.id, { label: "Pagamento riuscito", trigger: "auto", guard: "esito ok", effect: "crea l'ordine" });
    b.link(f, outcome.id, pay.id, { label: "Riprova", trigger: "auto", guard: "esito rifiutato" });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Dashboard SaaS
// ---------------------------------------------------------------------------
const saas: Template = {
  id: "saas", name: "Dashboard SaaS", tagline: "Elenco, dettaglio e impostazioni di un'app di lavoro.", icon: "grid", docName: "Dashboard SaaS",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const tabBar = (s: ReturnType<DocBuilder["screen"]>, active: "home" | "settings") => {
      s.box(0, 764, W, 80, { fill: PALETTE.white, name: "Barra schede" });
      s.box(0, 764, W, 1, { fill: PALETTE.line, name: "Filo schede" });
      s.text("Progetti", 0, 790, W / 2, { size: 13, weight: active === "home" ? "700" : "500", color: active === "home" ? PALETTE.accent : PALETTE.muted, align: "center", name: "Scheda Progetti" });
      return s.button("Impostazioni", W / 2, 784, W / 2, active === "home" ? "tab-settings" : "tab-settings-active", "link", 40);
    };

    const list = b.screen("Dashboard", 0, 0, { route: "/progetti", bg: PALETTE.bgSoft });
    list.header("Progetti");
    list.stat("Attivi", "8", PAD, 120, (CW - 24) / 3, 76);
    list.stat("In ritardo", "2", PAD + (CW - 24) / 3 + 12, 120, (CW - 24) / 3, 76);
    list.stat("Chiusi", "31", PAD + 2 * ((CW - 24) / 3 + 12), 120, (CW - 24) / 3, 76);
    list.text("Recenti", PAD, 222, CW, { size: 14, weight: "600", color: PALETTE.muted, name: "Intestazione elenco" });
    const alfa = list.row("Progetto Alfa", "Aggiornato oggi", PAD, 252, CW, "list-alfa");
    list.row("Progetto Beta", "Aggiornato ieri", PAD, 328, CW, "list-beta");
    list.row("Progetto Gamma", "Aggiornato 3 giorni fa", PAD, 404, CW, "list-gamma");
    const toSettings = tabBar(list, "home");

    const detail = b.screen("Dettaglio progetto", 1, 0, { route: "/progetti/:id", bg: PALETTE.bgSoft });
    detail.header("Progetto Alfa");
    detail.text("Stato", PAD, 124, CW, { size: 13, weight: "500", color: PALETTE.muted, name: "Etichetta stato" });
    detail.box(PAD, 148, 96, 28, { fill: PALETTE.okSoft, radius: 14, name: "Pillola stato" });
    detail.text("In corso", PAD, 153, 96, { size: 13, weight: "600", color: PALETTE.ok, align: "center", name: "Stato" });
    detail.stat("Avanzamento", "64%", PAD, 204, (CW - 12) / 2);
    detail.stat("Attività", "24", PAD + (CW - 12) / 2 + 12, 204, (CW - 12) / 2);
    detail.row("Giulia B.", "Responsabile", PAD, 312, CW, "detail-owner");
    detail.row("Team Design", "4 persone", PAD, 388, CW, "detail-team");
    const edit = detail.button("Modifica impostazioni", PAD, 560, CW, "detail-edit");
    const detailBack = detail.button("Torna ai progetti", PAD, 624, CW, "detail-back", "link", 32);

    const settings = b.screen("Impostazioni", 2, 0, { route: "/impostazioni", bg: PALETTE.bgSoft });
    settings.header("Impostazioni");
    settings.input("Nome del progetto", "Progetto Alfa", PAD, 120, CW, "set-name");
    settings.input("Email di riferimento", "team@azienda.it", PAD, 210, CW, "set-email");
    settings.row("Notifiche", "Avvisi per le scadenze", PAD, 310, CW, "set-notify");
    const save = settings.button("Salva", PAD, 600, CW, "set-save");
    const cancel = settings.button("Annulla", PAD, 664, CW, "set-cancel", "secondary");

    const f = b.flow("Gestione progetti", list.id, "Dall'elenco al dettaglio, fino alle impostazioni.");
    b.link(f, list.id, detail.id, { label: "Apri progetto", elementId: alfa });
    b.link(f, list.id, settings.id, { label: "Impostazioni", elementId: toSettings });
    b.link(f, detail.id, settings.id, { label: "Modifica impostazioni", elementId: edit });
    b.link(f, detail.id, list.id, { label: "Torna ai progetti", trigger: "back", elementId: detailBack });
    b.link(f, settings.id, list.id, { label: "Salva", trigger: "submit", elementId: save, effect: "salva le modifiche" });
    b.link(f, settings.id, detail.id, { label: "Annulla", elementId: cancel });
    return b.built();
  },
};

export const TEMPLATES: readonly Template[] = [blank, onboarding, auth, checkout, saas];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Gli Op che portano un documento appena creato allo stato del template. */
export function templateOps(t: Template, docId: string, pageId: string, newId: IdGen = () => crypto.randomUUID()): Op[] {
  return builtToOps(t.build(pageId, newId), docId);
}
