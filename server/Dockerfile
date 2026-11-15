# Hisaab cloud server: a small static binary on a distroless base.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /hisaab-server .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /hisaab-server /hisaab-server
EXPOSE 8080
ENV HISAAB_ADDR=:8080
ENTRYPOINT ["/hisaab-server"]
