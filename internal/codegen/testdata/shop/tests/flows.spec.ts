// File generato da opendesigner (opendesigner flow tests): NON modificare a mano,
// rigenerare dal grafo dei flussi.
// Documento: Negozio (shop)
// Flussi: tutti
import { expect, test } from '@playwright/test';

test.describe("Flusso: Acquisto", () => {
  test("percorso 1: Login → Home → Dettaglio → Home (ciclo)", async ({ page }) => {
    await page.goto("/login");

    // flow:t1
    // Login -> Home
    // guard: credenziali valide
    // effect: sessione attiva
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/home/?(?:[?#].*)?$"));

    // flow:t2
    // Home -> Dettaglio
    await page.getByText("Cuffie wireless").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/dettaglio/?(?:[?#].*)?$"));

    // flow:t4
    // Dettaglio -> Home
    await page.getByRole('button', { name: "Indietro" }).click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/home/?(?:[?#].*)?$"));
  });
  test("percorso 2: Login → Home → Login (ciclo)", async ({ page }) => {
    await page.goto("/login");

    // flow:t1
    // Login -> Home
    // guard: credenziali valide
    // effect: sessione attiva
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/home/?(?:[?#].*)?$"));

    // flow:t3
    // Home -> Login
    await page.getByRole('button', { name: "Esci" }).click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/login/?(?:[?#].*)?$"));
  });
});
