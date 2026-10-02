# brawt

brawt is a local-first design editor for vector graphics, built around a Go backend, a TypeScript frontend, and an MCP-powered co-design workflow. The project aims to provide a fast, inspectable editing experience for shapes, text, images, and vector paths while keeping the data model explicit and easy to reason about.

The repository currently includes:

- a Go server that exposes typed Connect RPC APIs and persists documents on disk
- a Vite + React + TypeScript canvas editor
- an MCP server mode that lets an AI agent act as another client editing the same document
- a protobuf-based document model and event-sourced persistence layer

## Why this project exists

The long-term goal is to create an open-source design tool that is:

- local-first and easy to run on a single machine
- transparent in its data model and persistence format
- extensible enough to support AI-assisted editing through MCP
- grounded in a clear architecture instead of a monolithic UI layer

## Current status

The implementation is progressing through milestone-driven development. The current focus is the vertical slice for document creation, persistence, sync, and basic canvas editing.

## Architecture at a glance

The system is split into three main layers:

1. Frontend
   - Vite + React + TypeScript
   - Canvas 2D renderer
   - tool system for selection, move, resize, and other editing interactions
   - Zustand-based state management

2. Backend
   - Go server with Connect RPC handlers
   - document core that applies operations, enforces invariants, and persists state
   - document streaming and synchronization logic

3. MCP layer
   - a separate stdio-based MCP server that connects to the same document runtime
   - AI tools can submit edits as operations and receive live updates

## Repository layout

- cmd/opendesigner: CLI entrypoints for serving the app and running the MCP server
- internal/core: core document state and operation application logic
- internal/mcp: MCP client/server implementation and tool registration
- internal/server: document service, asset serving, websocket-like streaming plumbing, and manager logic
- internal/store: persistence, snapshot handling, oplog storage, and document loading
- proto/opendesigner/v1: protobuf definitions for the document model and RPC contracts
- web: frontend application, renderer, store, tools, and UI modules
- testdata/golden: golden fixtures for validation and regression coverage

## Prerequisites

You will need:

- Go 1.25 or newer
- Node.js 20+ and pnpm 11+
- optional: buf CLI if you plan to regenerate protobuf stubs

## Getting started

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd brawt
pnpm install --dir web
```

### 2. Run the backend server

```bash
go run ./cmd/opendesigner serve
```

This starts the document service on port 8080 by default. The server stores documents in the default workspace location, which is typically under your home directory in a folder named .opendesigner.

### 3. Build and serve the web app

For a production build:

```bash
pnpm --dir web build
```

Then run the server with the built frontend directory:

```bash
go run ./cmd/opendesigner serve -web web/dist
```

For development, you can also run the Vite dev server directly:

```bash
pnpm --dir web dev
```

### 4. Work together on the same network

No accounts: start the server and share the address it prints.

```bash
opendesigner serve
# sulla stessa rete apri: http://192.168.1.20:8080
```

Everyone picks a nickname in the toolbar. The **Condividi** button copies the
link of the open document (`...#doc=<id>`); whoever opens it edits the same
document and sees the others' cursors and selections. Presence is ephemeral and
never written to the document.

There is no authentication: anyone who can reach the port can edit. Use it on a
network you trust, or bind to loopback with `-addr 127.0.0.1:8080`.

### 5. Run the MCP server

Start the backend first, then run:

```bash
go run ./cmd/opendesigner mcp
```

The MCP mode connects to the running serve instance and exposes editing tools through stdio.

## Development workflow

### Run Go tests

```bash
go test ./...
```

### Run frontend tests

```bash
pnpm --dir web test
```

### Regenerate protobuf bindings

If you change the protobuf definitions, regenerate the Go and TypeScript outputs with the repository’s buf setup.

```bash
buf generate
```

## Data model and persistence

The document model is designed around an explicit scene graph and operation-based updates:

- documents are stored as a bundle directory with metadata, snapshots, and an oplog
- changes are recorded as operations and replayed to reconstruct the state
- snapshots provide compact recovery points while the oplog preserves history
- assets are stored using content-based hashes and referenced from nodes

This makes the system suitable for local persistence, crash recovery, and AI-driven editing with deterministic state transitions.

## Contributing

Contributions are welcome. A good starting point is to explore the core document flow in the following areas:

- operation application and validation in internal/core
- sync and document service behavior in internal/server
- renderer and editing interactions in web/src
- protobuf contract changes in proto/opendesigner/v1

When changing behavior, prefer adding or updating tests around the relevant domain.

## License

This project is licensed under the GNU Affero General Public License v3.0. See [LICENSE.md](license.md) for the full text.
