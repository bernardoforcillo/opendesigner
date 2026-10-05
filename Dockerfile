# syntax=docker/dockerfile:1

# stages 1-3 run on the build machine's architecture ($BUILDPLATFORM):
# their result does not depend on the architecture (sources, assets) or is
# cross-compiled, so the multi-arch image does not require emulation

# 1) code generated from protobuf (Go + TS)
FROM --platform=$BUILDPLATFORM bufbuild/buf:latest AS gen
WORKDIR /src
COPY buf.yaml buf.gen.yaml ./
COPY proto ./proto
RUN buf generate

# 2) frontend
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
# since Node 25 corepack is no longer bundled: install it
RUN npm install -g corepack && corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./
COPY --from=gen /src/web/src/gen ./src/gen
RUN pnpm build

# 3) binary (the frontend is embedded with go:embed)
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=gen /src/gen ./gen
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /opendesigner ./cmd/opendesigner
# /data must exist in the image owned by nonroot: a new volume inherits
# its permissions, otherwise it is created as root and the server cannot write to it
RUN mkdir /data

# 4) final image
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /opendesigner /opendesigner
COPY --from=build --chown=nonroot:nonroot /data /data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/opendesigner", "serve", "-addr", ":8080", "-workspace", "/data"]
