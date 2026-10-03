# Specifica dei flussi — Shop

## Flusso: Acquisto (`checkout`)

Dal catalogo alla conferma d'ordine.

Schermata iniziale: **Home**

### Schermate

| Nome | Tipo | Rotta | Componente | Stato |
|---|---|---|---|---|
| Carrello | screen | `/cart/:id` | — | planned |
| Grazie | end | `/thanks` | — | planned |
| Home | screen | `/` | `HomePage` | implemented |
| Login | screen | `/login` | `LoginPage` | planned |
| Pagamento | screen | — | — | planned |

### Transizioni

1. **Carrello** --[back]--> **Home** (effect: svuota il carrello) `flow:t-back`
2. **Login** --[submit: Carrello]--> **Carrello** `flow:t-cart`
3. **Pagamento** --[auto]--> **Grazie** `flow:t-done`
4. **Home** --[key: Enter]--> **Carrello** `flow:t-key`
5. **Home** --[click: Accedi]--> **Login** `flow:t-login`
6. **Carrello** --[click: Paga]--> **Pagamento** (guard: carrello non vuoto; effect: ordine creato) `flow:t-pay`

### Scenari

#### Scenario 1: Home → Login → Carrello → Home (si chiude in un ciclo)

- **Given** l'utente è sulla schermata **Home** (`/`)
- **When** l'utente fa click su "Accedi" (elemento **Bottone login**)
- **Then** vede la schermata **Login** (`/login`)
- **When** l'utente invia "Carrello" (elemento **Link carrello**)
- **Then** vede la schermata **Carrello** (`/cart/:id`)
- **When** l'utente torna indietro
- **Then** vede la schermata **Home** (`/`) e: svuota il carrello

#### Scenario 2: Home → Login → Carrello → Pagamento → Grazie

- **Given** l'utente è sulla schermata **Home** (`/`)
- **When** l'utente fa click su "Accedi" (elemento **Bottone login**)
- **Then** vede la schermata **Login** (`/login`)
- **When** l'utente invia "Carrello" (elemento **Link carrello**)
- **Then** vede la schermata **Carrello** (`/cart/:id`)
- **When** l'utente fa click su "Paga" (se carrello non vuoto)
- **Then** vede la schermata **Pagamento** e: ordine creato
- **When** il sistema passa automaticamente oltre
- **Then** vede la schermata **Grazie** (`/thanks`)

#### Scenario 3: Home → Carrello → Home (si chiude in un ciclo)

- **Given** l'utente è sulla schermata **Home** (`/`)
- **When** l'utente preme "Enter"
- **Then** vede la schermata **Carrello** (`/cart/:id`)
- **When** l'utente torna indietro
- **Then** vede la schermata **Home** (`/`) e: svuota il carrello

#### Scenario 4: Home → Carrello → Pagamento → Grazie

- **Given** l'utente è sulla schermata **Home** (`/`)
- **When** l'utente preme "Enter"
- **Then** vede la schermata **Carrello** (`/cart/:id`)
- **When** l'utente fa click su "Paga" (se carrello non vuoto)
- **Then** vede la schermata **Pagamento** e: ordine creato
- **When** il sistema passa automaticamente oltre
- **Then** vede la schermata **Grazie** (`/thanks`)

### Problemi

Nessun problema rilevato.
