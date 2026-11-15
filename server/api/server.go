// Package api is the Hisaab cloud: accounts, shops, device pairing, the sync feed and encrypted backups.
package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// IDBlock is the size of each device's id range: device n creates ids in [n·10¹², (n+1)·10¹²).
const IDBlock int64 = 1_000_000_000_000

type Server struct {
	DB      *pgxpool.Pool
	limiter *limiter
	Now     func() time.Time
}

func New(ctx context.Context, dsn string) (*Server, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	if _, err := pool.Exec(ctx, schemaSQL); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Server{DB: pool, limiter: newLimiter(20, time.Minute), Now: time.Now}, nil
}

func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) })

	m.HandleFunc("POST /v1/auth/signup", s.limited(s.signup))
	m.HandleFunc("POST /v1/auth/login", s.limited(s.login))
	m.HandleFunc("GET /v1/shops", s.account(s.listShops))
	m.HandleFunc("POST /v1/shops", s.account(s.createShop))
	m.HandleFunc("POST /v1/shops/{id}/devices", s.account(s.addDeviceAsOwner))

	m.HandleFunc("POST /v1/pairing-codes", s.device(s.createPairingCode))
	m.HandleFunc("POST /v1/devices/pair", s.limited(s.pair))
	m.HandleFunc("GET /v1/devices", s.device(s.listDevices))
	m.HandleFunc("PATCH /v1/devices/{id}", s.device(s.renameDevice))
	m.HandleFunc("DELETE /v1/devices/{id}", s.device(s.revokeDevice))

	m.HandleFunc("POST /v1/sync/push", s.device(s.push))
	m.HandleFunc("GET /v1/sync/pull", s.device(s.pull))

	m.HandleFunc("POST /v1/backups", s.device(s.uploadBackup))
	m.HandleFunc("GET /v1/backups", s.either(s.listBackups))
	m.HandleFunc("GET /v1/backups/{id}", s.either(s.downloadBackup))
	return cors(m)
}

/* ───────── auth ───────── */

type principal struct {
	AccountID string
	Device    *deviceRow
}

type deviceRow struct {
	ID, ShopID, Name, Kind string
	Index                  int
}

type ctxKey struct{}

func who(r *http.Request) principal { return r.Context().Value(ctxKey{}).(principal) }

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

func (s *Server) resolve(r *http.Request) (principal, error) {
	tok := bearer(r)
	switch {
	case strings.HasPrefix(tok, "acc_"):
		var id string
		err := s.DB.QueryRow(r.Context(), `SELECT account_id FROM sessions WHERE token_hash = $1 AND expires_at > now()`, hashToken(tok)).Scan(&id)
		if err != nil {
			return principal{}, errUnauthorized
		}
		return principal{AccountID: id}, nil
	case strings.HasPrefix(tok, "dev_"):
		d := &deviceRow{}
		err := s.DB.QueryRow(r.Context(), `SELECT id, shop_id, name, kind, idx FROM devices WHERE token_hash = $1 AND revoked_at IS NULL`, hashToken(tok)).
			Scan(&d.ID, &d.ShopID, &d.Name, &d.Kind, &d.Index)
		if err != nil {
			return principal{}, errUnauthorized
		}
		_, _ = s.DB.Exec(r.Context(), `UPDATE devices SET last_seen_at = now() WHERE id = $1`, d.ID)
		return principal{Device: d}, nil
	}
	return principal{}, errUnauthorized
}

var errUnauthorized = &httpError{401, "Sign in again: this device or session is not recognised."}

func (s *Server) wrap(check func(principal) bool, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.resolve(r)
		if err != nil || !check(p) {
			writeErr(w, errUnauthorized)
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, p)))
	}
}
func (s *Server) account(h http.HandlerFunc) http.HandlerFunc {
	return s.wrap(func(p principal) bool { return p.AccountID != "" }, h)
}
func (s *Server) device(h http.HandlerFunc) http.HandlerFunc {
	return s.wrap(func(p principal) bool { return p.Device != nil }, h)
}
func (s *Server) either(h http.HandlerFunc) http.HandlerFunc {
	return s.wrap(func(p principal) bool { return true }, h)
}

// limited throttles sign-in and pairing per client IP (a 6-digit code must not be guessable).
func (s *Server) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			ip = strings.TrimSpace(strings.Split(fwd, ",")[0])
		}
		if !s.limiter.allow(ip + r.URL.Path) {
			writeErr(w, &httpError{429, "Too many attempts. Wait a minute and try again."})
			return
		}
		h(w, r)
	}
}

/* ───────── helpers ───────── */

type httpError struct {
	Status int
	Msg    string
}

func (e *httpError) Error() string { return e.Msg }

func bad(msg string, a ...any) *httpError { return &httpError{400, fmt.Sprintf(msg, a...)} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var he *httpError
	if errors.As(err, &he) {
		writeJSON(w, he.Status, map[string]string{"error": he.Msg})
		return
	}
	log.Printf("internal error: %v", err)
	writeJSON(w, 500, map[string]string{"error": "Something went wrong on the server. Try again."})
}

func readJSON(r *http.Request, v any, max int64) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, max))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return bad("Invalid request: %v", err)
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func newID(prefix string) string { return prefix + randomHex(12) }

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bearer tokens, no cookies: any origin may call (the desktop app runs from tauri:// or localhost).
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Hisaab-Note")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func inTx(ctx context.Context, db *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	keep := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			keep = append(keep, t)
		}
	}
	if len(keep) >= l.max {
		l.hits[key] = keep
		return false
	}
	l.hits[key] = append(keep, now)
	if len(l.hits) > 100_000 { // don't grow without bound
		l.hits = map[string][]time.Time{}
	}
	return true
}
