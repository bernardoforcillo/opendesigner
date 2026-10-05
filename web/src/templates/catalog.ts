import type { IconName } from "../ui/ds/Icon";
import { builtToOps, DocBuilder, PALETTE, SCREEN_W } from "./builder";
import type { BuiltTemplate, IdGen } from "./builder";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// THE TEMPLATE CATALOG. Each one is a REAL starting point: 390x844 mobile
// screens with a plausible interface (titles, fields, buttons), an already
// connected flow, and `test.id` on every hotspot + `code.route` on every screen,
// so the prototype can be played right away and the exported code/Playwright are useful.
//
// All functions are pure: the same template, with the same id
// generator, produces the same nodes (the tests rely on it).

export interface Template {
  id: string;
  name: string;
  /** One line: what it contains. */
  tagline: string;
  icon: IconName;
  /** The name the document is born with. */
  docName: string;
  build: (pageId: string, newId: IdGen) => BuiltTemplate;
}

const W = SCREEN_W;
const PAD = 24;
const CW = W - 2 * PAD; // content width

// ---------------------------------------------------------------------------
// Blank
// ---------------------------------------------------------------------------
const blank: Template = {
  id: "blank", name: "Blank", tagline: "A blank board: you draw.", icon: "plus", docName: "Untitled",
  build: () => ({ nodes: [], flows: [], transitions: [] }),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
const onboarding: Template = {
  id: "onboarding", name: "Onboarding", tagline: "Welcome, choice, done: 3 connected screens.", icon: "sparkle", docName: "Onboarding",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const welcome = b.screen("Welcome", 0, 0, { route: "/welcome" });
    welcome.circle(W / 2 - 90, 150, 180, PALETTE.accentSoft, "Illustration");
    welcome.circle(W / 2 - 52, 188, 104, PALETTE.accent, "Illustration — core");
    welcome.text("Welcome to Aurora", PAD, 396, CW, { size: 28, weight: "700", align: "center", name: "Title" });
    welcome.text("Organize your work in one place, in less than a minute.", 40, 444, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Subtitle" });
    const start = welcome.button("Get started", PAD, 676, CW, "onb-start");
    welcome.button("I already have an account", PAD, 740, CW, "onb-login", "link");

    const choose = b.screen("Choose", 1, 0, { route: "/choose" });
    choose.text("What are you interested in?", PAD, 96, CW, { size: 26, weight: "700", name: "Title" });
    choose.text("We will tailor the app for you. You can change your mind later.", PAD, 136, CW, { size: 15, color: PALETTE.muted, h: 40, name: "Subtitle" });
    choose.row("Design", "Interfaces and prototypes", PAD, 210, CW, "onb-opt-design");
    choose.row("Development", "Code and components", PAD, 290, CW, "onb-opt-dev");
    choose.row("Product", "Roadmap and priorities", PAD, 370, CW, "onb-opt-product");
    const next = choose.button("Continue", PAD, 676, CW, "onb-next");
    const back = choose.button("Back", PAD, 740, CW, "onb-back", "link");

    const done = b.screen("Done", 2, 0, { route: "/done", kind: "end" });
    done.badge(W / 2, 220, 140, PALETTE.ok, "✓");
    done.text("All set", PAD, 396, CW, { size: 28, weight: "700", align: "center", name: "Title" });
    done.text("Your space is set up. You can start working.", 40, 444, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Subtitle" });
    done.button("Go to the app", PAD, 676, CW, "onb-finish");

    const f = b.flow("Onboarding", welcome.id, "From first launch to the configured app.");
    b.link(f, welcome.id, choose.id, { label: "Get started", elementId: start });
    b.link(f, choose.id, done.id, { label: "Continue", elementId: next });
    b.link(f, choose.id, welcome.id, { label: "Back", trigger: "back", elementId: back });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Login & sign-up
// ---------------------------------------------------------------------------
const auth: Template = {
  id: "auth", name: "Login and sign-up", tagline: "Sign in, sign up, recover, dashboard: with conditions.", icon: "lock", docName: "Login and sign-up",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const login = b.screen("Sign in", 0, 0, { route: "/login" });
    login.text("Welcome back", PAD, 120, CW, { size: 30, weight: "700", name: "Title" });
    login.text("Sign in to continue.", PAD, 166, CW, { size: 16, color: PALETTE.muted, name: "Subtitle" });
    login.input("Email", "name@company.com", PAD, 240, CW, "login-email");
    login.input("Password", "••••••••", PAD, 330, CW, "login-password");
    const forgot = login.button("Forgot password?", PAD, 410, CW, "login-forgot", "link", 32);
    const submit = login.button("Sign in", PAD, 470, CW, "login-submit");
    login.text("Don't have an account?", PAD, 760, CW, { size: 14, color: PALETTE.muted, align: "center", name: "Prompt" });
    const toSignup = login.button("Sign up", PAD, 784, CW, "login-signup", "link", 32);

    const signup = b.screen("Sign up", 1, 0, { route: "/signup" });
    signup.text("Create your account", PAD, 120, CW, { size: 30, weight: "700", name: "Title" });
    signup.text("It only takes a few seconds.", PAD, 166, CW, { size: 16, color: PALETTE.muted, name: "Subtitle" });
    signup.input("Name", "Your name", PAD, 220, CW, "signup-name");
    signup.input("Email", "name@company.com", PAD, 310, CW, "signup-email");
    signup.input("Password", "At least 8 characters", PAD, 400, CW, "signup-password");
    const create = signup.button("Create account", PAD, 500, CW, "signup-submit");
    signup.text("Already have an account?", PAD, 760, CW, { size: 14, color: PALETTE.muted, align: "center", name: "Prompt" });
    const toLogin = signup.button("Sign in", PAD, 784, CW, "signup-login", "link", 32);

    const recovery = b.screen("Password recovery", 2, 0, { route: "/recovery" });
    recovery.text("Recover your password", PAD, 120, CW, { size: 30, weight: "700", name: "Title" });
    recovery.text("We will send you a link to choose a new one.", PAD, 166, CW, { size: 16, color: PALETTE.muted, h: 44, name: "Subtitle" });
    recovery.input("Email", "name@company.com", PAD, 250, CW, "recovery-email");
    const send = recovery.button("Send the link", PAD, 350, CW, "recovery-submit");
    const recBack = recovery.button("Back to login", PAD, 414, CW, "recovery-back", "link", 32);

    const dash = b.screen("Dashboard", 3, 0, { route: "/app" });
    dash.header("Dashboard");
    dash.text("Hi, Julia", PAD, 124, CW, { size: 26, weight: "700", name: "Greeting" });
    dash.stat("Open tasks", "12", PAD, 176, (CW - 12) / 2);
    dash.stat("Completed", "38", PAD + (CW - 12) / 2 + 12, 176, (CW - 12) / 2);
    dash.row("Design review", "Due tomorrow", PAD, 288, CW, "dash-row-1");
    dash.row("Release 2.4", "In progress", PAD, 368, CW, "dash-row-2");
    const logout = dash.button("Sign out", PAD, 740, CW, "dash-logout", "secondary");

    const f = b.flow("Access", login.id, "Login, sign-up and password recovery up to the dashboard.");
    b.link(f, login.id, dash.id, { label: "Sign in", trigger: "submit", elementId: submit, guard: "valid credentials", effect: "creates the session" });
    b.link(f, login.id, signup.id, { label: "Sign up", elementId: toSignup });
    b.link(f, login.id, recovery.id, { label: "Forgot password?", elementId: forgot });
    b.link(f, signup.id, dash.id, { label: "Create account", trigger: "submit", elementId: create, guard: "valid data", effect: "creates the user and the session" });
    b.link(f, signup.id, login.id, { label: "Sign in", elementId: toLogin });
    b.link(f, recovery.id, login.id, { label: "Send the link", trigger: "submit", elementId: send, guard: "registered email", effect: "sends the recovery email" });
    b.link(f, recovery.id, login.id, { label: "Back to login", elementId: recBack });
    b.link(f, dash.id, login.id, { label: "Sign out", elementId: logout, effect: "ends the session" });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
const checkout: Template = {
  id: "checkout", name: "Checkout", tagline: "Cart, shipping, payment, confirmation + outcome.", icon: "download", docName: "Checkout",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const cart = b.screen("Cart", 0, 0, { route: "/cart" });
    cart.header("Cart");
    cart.row("Sneakers Aria", "Size 42 · 1 pc · $89.00", PAD, 120, CW, "cart-item-1", 72);
    cart.row("Urban Backpack", "Gray · 1 pc · $59.00", PAD, 204, CW, "cart-item-2", 72);
    cart.box(PAD, 560, CW, 1, { fill: PALETTE.line, name: "Total line" });
    cart.text("Total", PAD, 580, 120, { size: 16, color: PALETTE.muted, name: "Total label" });
    cart.text("$148.00", W - PAD - 160, 574, 160, { size: 24, weight: "700", align: "right", name: "Total" });
    const toShip = cart.button("Proceed to shipping", PAD, 700, CW, "cart-checkout");

    const ship = b.screen("Shipping", 1, 0, { route: "/shipping" });
    ship.header("Shipping");
    ship.input("Full name", "John Smith", PAD, 120, CW, "ship-name");
    ship.input("Address", "1 Main Street", PAD, 210, CW, "ship-address");
    ship.input("ZIP", "10001", PAD, 300, (CW - 12) / 2, "ship-zip");
    ship.input("City", "Springfield", PAD + (CW - 12) / 2 + 12, 300, (CW - 12) / 2, "ship-city");
    const toPay = ship.button("Continue to payment", PAD, 700, CW, "ship-next");
    const shipBack = ship.button("Back", PAD, 760, CW, "ship-back", "link", 32);

    const pay = b.screen("Payment", 2, 0, { route: "/payment" });
    pay.header("Payment");
    pay.input("Card number", "1234 5678 9012 3456", PAD, 120, CW, "pay-card");
    pay.input("Expiry", "MM/YY", PAD, 210, (CW - 12) / 2, "pay-exp");
    pay.input("CVV", "123", PAD + (CW - 12) / 2 + 12, 210, (CW - 12) / 2, "pay-cvv");
    pay.text("Total to pay: $148.00", PAD, 330, CW, { size: 15, color: PALETTE.muted, name: "Summary" });
    const payNow = pay.button("Pay now", PAD, 700, CW, "pay-submit");
    const payBack = pay.button("Back", PAD, 760, CW, "pay-back", "link", 32);

    // A DECISION is not a real screen: a short box that in the
    // prototype is crossed on its own according to the conditions (`flow.kind`).
    const outcome = b.screen("Payment successful?", 3, 0, { route: "/payment/outcome", kind: "decision", h: 300, bg: PALETTE.bgSoft });
    outcome.text("Payment successful?", PAD, 110, CW, { size: 24, weight: "700", align: "center", name: "Title" });
    outcome.text("The payment network replies with an outcome.", 40, 156, W - 80, { size: 15, color: PALETTE.muted, align: "center", h: 40, name: "Subtitle" });

    const done = b.screen("Confirmation", 4, 0, { route: "/order/confirmation", kind: "end" });
    done.badge(W / 2, 200, 140, PALETTE.ok, "✓");
    done.text("Order confirmed", PAD, 376, CW, { size: 28, weight: "700", align: "center", name: "Title" });
    done.text("We have emailed you the receipt.", 40, 424, W - 80, { size: 16, color: PALETTE.muted, align: "center", h: 44, name: "Subtitle" });
    done.button("Back to the store", PAD, 700, CW, "done-home");

    const f = b.flow("Purchase", cart.id, "From the cart to the order confirmation.");
    b.link(f, cart.id, ship.id, { label: "Proceed to shipping", elementId: toShip });
    b.link(f, ship.id, pay.id, { label: "Continue to payment", elementId: toPay, guard: "valid address" });
    b.link(f, ship.id, cart.id, { label: "Back", trigger: "back", elementId: shipBack });
    b.link(f, pay.id, outcome.id, { label: "Pay now", trigger: "submit", elementId: payNow, effect: "charges the card" });
    b.link(f, pay.id, ship.id, { label: "Back", trigger: "back", elementId: payBack });
    b.link(f, outcome.id, done.id, { label: "Payment successful", trigger: "auto", guard: "outcome ok", effect: "creates the order" });
    b.link(f, outcome.id, pay.id, { label: "Retry", trigger: "auto", guard: "outcome declined" });
    return b.built();
  },
};

// ---------------------------------------------------------------------------
// Dashboard SaaS
// ---------------------------------------------------------------------------
const saas: Template = {
  id: "saas", name: "Dashboard SaaS", tagline: "List, detail and settings of a work app.", icon: "grid", docName: "Dashboard SaaS",
  build(pageId, newId) {
    const b = new DocBuilder(pageId, newId);

    const tabBar = (s: ReturnType<DocBuilder["screen"]>, active: "home" | "settings") => {
      s.box(0, 764, W, 80, { fill: PALETTE.white, name: "Tab bar" });
      s.box(0, 764, W, 1, { fill: PALETTE.line, name: "Tab line" });
      s.text("Projects", 0, 790, W / 2, { size: 13, weight: active === "home" ? "700" : "500", color: active === "home" ? PALETTE.accent : PALETTE.muted, align: "center", name: "Projects tab" });
      return s.button("Settings", W / 2, 784, W / 2, active === "home" ? "tab-settings" : "tab-settings-active", "link", 40);
    };

    const list = b.screen("Dashboard", 0, 0, { route: "/projects", bg: PALETTE.bgSoft });
    list.header("Projects");
    list.stat("Active", "8", PAD, 120, (CW - 24) / 3, 76);
    list.stat("Late", "2", PAD + (CW - 24) / 3 + 12, 120, (CW - 24) / 3, 76);
    list.stat("Closed", "31", PAD + 2 * ((CW - 24) / 3 + 12), 120, (CW - 24) / 3, 76);
    list.text("Recent", PAD, 222, CW, { size: 14, weight: "600", color: PALETTE.muted, name: "List heading" });
    const alfa = list.row("Project Alpha", "Updated today", PAD, 252, CW, "list-alfa");
    list.row("Project Beta", "Updated yesterday", PAD, 328, CW, "list-beta");
    list.row("Project Gamma", "Updated 3 days ago", PAD, 404, CW, "list-gamma");
    const toSettings = tabBar(list, "home");

    const detail = b.screen("Project detail", 1, 0, { route: "/projects/:id", bg: PALETTE.bgSoft });
    detail.header("Project Alpha");
    detail.text("Status", PAD, 124, CW, { size: 13, weight: "500", color: PALETTE.muted, name: "Status label" });
    detail.box(PAD, 148, 96, 28, { fill: PALETTE.okSoft, radius: 14, name: "Status pill" });
    detail.text("In progress", PAD, 153, 96, { size: 13, weight: "600", color: PALETTE.ok, align: "center", name: "Status" });
    detail.stat("Progress", "64%", PAD, 204, (CW - 12) / 2);
    detail.stat("Tasks", "24", PAD + (CW - 12) / 2 + 12, 204, (CW - 12) / 2);
    detail.row("Julia B.", "Owner", PAD, 312, CW, "detail-owner");
    detail.row("Design Team", "4 people", PAD, 388, CW, "detail-team");
    const edit = detail.button("Edit settings", PAD, 560, CW, "detail-edit");
    const detailBack = detail.button("Back to projects", PAD, 624, CW, "detail-back", "link", 32);

    const settings = b.screen("Settings", 2, 0, { route: "/settings", bg: PALETTE.bgSoft });
    settings.header("Settings");
    settings.input("Project name", "Project Alpha", PAD, 120, CW, "set-name");
    settings.input("Contact email", "team@company.com", PAD, 210, CW, "set-email");
    settings.row("Notifications", "Deadline alerts", PAD, 310, CW, "set-notify");
    const save = settings.button("Save", PAD, 600, CW, "set-save");
    const cancel = settings.button("Cancel", PAD, 664, CW, "set-cancel", "secondary");

    const f = b.flow("Project management", list.id, "From the list to the detail, up to the settings.");
    b.link(f, list.id, detail.id, { label: "Open project", elementId: alfa });
    b.link(f, list.id, settings.id, { label: "Settings", elementId: toSettings });
    b.link(f, detail.id, settings.id, { label: "Edit settings", elementId: edit });
    b.link(f, detail.id, list.id, { label: "Back to projects", trigger: "back", elementId: detailBack });
    b.link(f, settings.id, list.id, { label: "Save", trigger: "submit", elementId: save, effect: "saves the changes" });
    b.link(f, settings.id, detail.id, { label: "Cancel", elementId: cancel });
    return b.built();
  },
};

export const TEMPLATES: readonly Template[] = [blank, onboarding, auth, checkout, saas];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** The Ops that bring a just-created document to the template's state. */
export function templateOps(t: Template, docId: string, pageId: string, newId: IdGen = () => crypto.randomUUID()): Op[] {
  return builtToOps(t.build(pageId, newId), docId);
}
