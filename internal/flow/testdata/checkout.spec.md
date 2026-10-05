# Flow spec — Shop

## Flow: Purchase (`checkout`)

From the catalog to the order confirmation.

Start screen: **Home**

### Screens

| Name | Type | Route | Component | Status |
|---|---|---|---|---|
| Cart | screen | `/cart/:id` | — | planned |
| Home | screen | `/` | `HomePage` | implemented |
| Login | screen | `/login` | `LoginPage` | planned |
| Payment | screen | — | — | planned |
| Thanks | end | `/thanks` | — | planned |

### Transitions

1. **Cart** --[back]--> **Home** (effect: empties the cart) `flow:t-back`
2. **Login** --[submit: Cart]--> **Cart** `flow:t-cart`
3. **Payment** --[auto]--> **Thanks** `flow:t-done`
4. **Home** --[key: Enter]--> **Cart** `flow:t-key`
5. **Home** --[click: Log in]--> **Login** `flow:t-login`
6. **Cart** --[click: Pay]--> **Payment** (guard: cart not empty; effect: order created) `flow:t-pay`

### Scenarios

#### Scenario 1: Home → Cart → Home (ends in a cycle)

- **Given** the user is on screen **Home** (`/`)
- **When** the user presses "Enter"
- **Then** sees screen **Cart** (`/cart/:id`)
- **When** the user goes back
- **Then** sees screen **Home** (`/`) and: empties the cart

#### Scenario 2: Home → Cart → Payment → Thanks

- **Given** the user is on screen **Home** (`/`)
- **When** the user presses "Enter"
- **Then** sees screen **Cart** (`/cart/:id`)
- **When** the user clicks "Pay" (if cart not empty)
- **Then** sees screen **Payment** and: order created
- **When** the system moves on automatically
- **Then** sees screen **Thanks** (`/thanks`)

#### Scenario 3: Home → Login → Cart → Home (ends in a cycle)

- **Given** the user is on screen **Home** (`/`)
- **When** the user clicks "Log in" (element **Login button**)
- **Then** sees screen **Login** (`/login`)
- **When** the user submits "Cart" (element **Cart link**)
- **Then** sees screen **Cart** (`/cart/:id`)
- **When** the user goes back
- **Then** sees screen **Home** (`/`) and: empties the cart

#### Scenario 4: Home → Login → Cart → Payment → Thanks

- **Given** the user is on screen **Home** (`/`)
- **When** the user clicks "Log in" (element **Login button**)
- **Then** sees screen **Login** (`/login`)
- **When** the user submits "Cart" (element **Cart link**)
- **Then** sees screen **Cart** (`/cart/:id`)
- **When** the user clicks "Pay" (if cart not empty)
- **Then** sees screen **Payment** and: order created
- **When** the system moves on automatically
- **Then** sees screen **Thanks** (`/thanks`)

### Issues

No issues found.
