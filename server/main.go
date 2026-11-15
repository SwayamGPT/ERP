// Command hisaab-server runs the Hisaab cloud: sync between a shop's devices and encrypted backups.
//
//	HISAAB_DB    Postgres connection string (required), e.g. postgres://hisaab:secret@localhost:5432/hisaab
//	HISAAB_ADDR  listen address (default :8080)
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/swayamgpt/erp/server/api"
)

func main() {
	dsn := os.Getenv("HISAAB_DB")
	if dsn == "" {
		log.Fatal("set HISAAB_DB to a Postgres connection string")
	}
	addr := os.Getenv("HISAAB_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var srv *api.Server
	var err error
	for i := 0; i < 30; i++ { // wait for the database to come up (docker compose)
		if srv, err = api.New(ctx, dsn); err == nil {
			break
		}
		log.Printf("waiting for database: %v", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatal(err)
	}
	hs := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sh)
	}()
	log.Printf("hisaab-server listening on %s", addr)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
