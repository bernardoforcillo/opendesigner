# syntax=docker/dockerfile:1

# le fasi 1-3 girano sull'architettura della macchina di build ($BUILDPLATFORM):
# il loro risultato non dipende dall'architettura (sorgenti, asset) oppure è
# compilato in modo incrociato, così l'immagine multi-arch non richiede emulazione

# 1) codice generato da protobuf (Go + TS)
FROM --platform=$BUILDPLATFORM bufbuild/buf:latest AS gen
WORKDIR /src
COPY buf.yaml buf.gen.yaml ./
COPY proto ./proto
RUN buf generate

# 2) frontend
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
# da Node 25 corepack non è più incluso: lo si installa
RUN npm install -g corepack && corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./
COPY --from=gen /src/web/src/gen ./src/gen
RUN pnpm build

# 3) binario (il frontend viene incorporato con go:embed)
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=gen /src/gen ./gen
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /opendesigner ./cmd/opendesigner
# /data deve esistere nell'immagine con proprietario nonroot: un volume nuovo
# ne eredita i permessi, altrimenti nasce di root e il server non può scriverci
RUN mkdir /data

# 4) immagine finale
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /opendesigner /opendesigner
COPY --from=build --chown=nonroot:nonroot /data /data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/opendesigner", "serve", "-addr", ":8080", "-workspace", "/data"]
