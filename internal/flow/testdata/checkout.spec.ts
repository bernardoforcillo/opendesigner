// File generato da opendesigner (opendesigner flow tests): NON modificare a mano,
// rigenerare dal grafo dei flussi.
// Documento: Shop (doc1)
// Flusso: Acquisto (checkout)
import { expect, test } from '@playwright/test';

test.describe("Flusso: Acquisto", () => {
  test("percorso 1: Home → Login → Carrello → Home (ciclo)", async ({ page }) => {
    await page.goto("/");

    // flow:t-login
    // Home -> Login
    await page.getByTestId("go-login").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/login/?(?:[?#].*)?$"));

    // flow:t-cart
    // Login -> Carrello
    await page.getByText("Vai al carrello").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$"));

    // flow:t-back
    // Carrello -> Home
    // effect: svuota il carrello
    await page.goBack();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/?(?:[?#].*)?$"));
  });
  test("percorso 2: Home → Login → Carrello → Pagamento → Grazie", async ({ page }) => {
    await page.goto("/");

    // flow:t-login
    // Home -> Login
    await page.getByTestId("go-login").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/login/?(?:[?#].*)?$"));

    // flow:t-cart
    // Login -> Carrello
    await page.getByText("Vai al carrello").click();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$"));

    // flow:t-pay
    // Carrello -> Pagamento
    // guard: carrello non vuoto
    // effect: ordine creato
    await page.getByRole('button', { name: "Paga" }).click();

    // flow:t-done
    // Pagamento -> Grazie
    // trigger auto: nessuna azione, la transizione scatta da sola
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/thanks/?(?:[?#].*)?$"));
  });
  test("percorso 3: Home → Carrello → Home (ciclo)", async ({ page }) => {
    await page.goto("/");

    // flow:t-key
    // Home -> Carrello
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$"));

    // flow:t-back
    // Carrello -> Home
    // effect: svuota il carrello
    await page.goBack();
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/?(?:[?#].*)?$"));
  });
  test("percorso 4: Home → Carrello → Pagamento → Grazie", async ({ page }) => {
    await page.goto("/");

    // flow:t-key
    // Home -> Carrello
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$"));

    // flow:t-pay
    // Carrello -> Pagamento
    // guard: carrello non vuoto
    // effect: ordine creato
    await page.getByRole('button', { name: "Paga" }).click();

    // flow:t-done
    // Pagamento -> Grazie
    // trigger auto: nessuna azione, la transizione scatta da sola
    await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/thanks/?(?:[?#].*)?$"));
  });
});
