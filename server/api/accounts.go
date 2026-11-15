package api

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

const sessionTTL = 30 * 24 * time.Hour

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := readJSON(r, &c, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if _, err := mail.ParseAddress(email); err != nil || !strings.Contains(email, "@") {
		writeErr(w, bad("Enter a valid email address."))
		return
	}
	if len(c.Password) < 8 {
		writeErr(w, bad("Use a password of at least 8 characters."))
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, err)
		return
	}
	id := newID("acc")
	_, err = s.DB.Exec(r.Context(), `INSERT INTO accounts (id, email, name, pass_hash) VALUES ($1, $2, $3, $4)`, id, email, strings.TrimSpace(c.Name), string(hash))
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		writeErr(w, &httpError{409, "An account with this email already exists. Sign in instead."})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	s.issueSession(w, r, id, email)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := readJSON(r, &c, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	var id, hash string
	err := s.DB.QueryRow(r.Context(), `SELECT id, pass_hash FROM accounts WHERE email = $1`, strings.ToLower(strings.TrimSpace(c.Email))).Scan(&id, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil {
		writeErr(w, &httpError{401, "Wrong email or password."})
		return
	}
	s.issueSession(w, r, id, c.Email)
}

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, accountID, email string) {
	tok := "acc_" + randomHex(24)
	if _, err := s.DB.Exec(r.Context(), `INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`, hashToken(tok), accountID, s.Now().Add(sessionTTL)); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"token": tok, "accountId": accountID, "email": strings.ToLower(strings.TrimSpace(email))})
}

/* ───────── shops ───────── */

type shopOut struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Devices   int       `json:"devices"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Server) listShops(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Query(r.Context(), `SELECT s.id, s.name, s.created_at, (SELECT COUNT(*) FROM devices d WHERE d.shop_id = s.id AND d.revoked_at IS NULL)
		FROM shops s WHERE s.owner_id = $1 ORDER BY s.created_at`, who(r).AccountID)
	if err != nil {
		writeErr(w, err)
		return
	}
	out := []shopOut{}
	for rows.Next() {
		var o shopOut
		if err := rows.Scan(&o.ID, &o.Name, &o.CreatedAt, &o.Devices); err != nil {
			writeErr(w, err)
			return
		}
		out = append(out, o)
	}
	writeJSON(w, 200, map[string]any{"shops": out})
}

func (s *Server) createShop(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		writeErr(w, bad("Enter the shop's name."))
		return
	}
	id := newID("shop")
	if _, err := s.DB.Exec(r.Context(), `INSERT INTO shops (id, name, owner_id) VALUES ($1, $2, $3)`, id, name, who(r).AccountID); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "name": name})
}

type deviceCreds struct {
	ShopID      string `json:"shopId"`
	ShopName    string `json:"shopName"`
	DeviceID    string `json:"deviceId"`
	DeviceToken string `json:"deviceToken"`
	DeviceIndex int    `json:"deviceIndex"`
	DeviceName  string `json:"deviceName"`
}

type deviceIn struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Code string `json:"code"`
}

func (in *deviceIn) clean() error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return bad("Give this device a name, e.g. Counter 2.")
	}
	if in.Kind == "" {
		in.Kind = "counter"
	}
	if in.Kind != "counter" && in.Kind != "phone" {
		return bad("Device kind must be counter or phone.")
	}
	return nil
}

// registerDevice gives the device the shop's next index (its id block and bill-series letter).
func (s *Server) registerDevice(tx pgx.Tx, r *http.Request, shopID string, in deviceIn) (deviceCreds, error) {
	var c deviceCreds
	var idx int
	if err := tx.QueryRow(r.Context(), `UPDATE shops SET next_index = next_index + 1 WHERE id = $1 RETURNING next_index - 1, name`, shopID).Scan(&idx, &c.ShopName); err != nil {
		return c, err
	}
	tok := "dev_" + randomHex(24)
	c = deviceCreds{ShopID: shopID, ShopName: c.ShopName, DeviceID: newID("dev"), DeviceToken: tok, DeviceIndex: idx, DeviceName: in.Name}
	_, err := tx.Exec(r.Context(), `INSERT INTO devices (id, shop_id, idx, name, kind, token_hash) VALUES ($1, $2, $3, $4, $5, $6)`, c.DeviceID, shopID, idx, in.Name, in.Kind, hashToken(tok))
	return c, err
}

// addDeviceAsOwner connects the owner's own computer (usually the first device) without a pairing code.
func (s *Server) addDeviceAsOwner(w http.ResponseWriter, r *http.Request) {
	var in deviceIn
	if err := readJSON(r, &in, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	if err := in.clean(); err != nil {
		writeErr(w, err)
		return
	}
	shopID := r.PathValue("id")
	var c deviceCreds
	err := inTx(r.Context(), s.DB, func(tx pgx.Tx) error {
		var owner string
		if err := tx.QueryRow(r.Context(), `SELECT owner_id FROM shops WHERE id = $1 FOR UPDATE`, shopID).Scan(&owner); err != nil || owner != who(r).AccountID {
			return &httpError{404, "Shop not found."}
		}
		var err error
		c, err = s.registerDevice(tx, r, shopID, in)
		return err
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, c)
}

/* ───────── pairing ───────── */

const pairingTTL = 15 * time.Minute

func (s *Server) createPairingCode(w http.ResponseWriter, r *http.Request) {
	d := who(r).Device
	for i := 0; i < 5; i++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(1_000_000))
		code := fmt.Sprintf("%06d", n.Int64())
		exp := s.Now().Add(pairingTTL)
		_, err := s.DB.Exec(r.Context(), `INSERT INTO pairing_codes (code, shop_id, created_by, expires_at) VALUES ($1, $2, $3, $4)`, code, d.ShopID, d.ID, exp)
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			_, _ = s.DB.Exec(r.Context(), `DELETE FROM pairing_codes WHERE expires_at < now()`)
			continue
		}
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"code": code, "expiresAt": exp})
		return
	}
	writeErr(w, &httpError{503, "Could not make a code. Try again."})
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var in deviceIn
	if err := readJSON(r, &in, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	if err := in.clean(); err != nil {
		writeErr(w, err)
		return
	}
	code := strings.ReplaceAll(strings.TrimSpace(in.Code), " ", "")
	var c deviceCreds
	err := inTx(r.Context(), s.DB, func(tx pgx.Tx) error {
		var shopID string
		err := tx.QueryRow(r.Context(), `UPDATE pairing_codes SET used_at = now() WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING shop_id`, code).Scan(&shopID)
		if err != nil {
			return &httpError{400, "That code is wrong or has expired. Make a new one on the main computer."}
		}
		if _, err := tx.Exec(r.Context(), `SELECT 1 FROM shops WHERE id = $1 FOR UPDATE`, shopID); err != nil {
			return err
		}
		c, err = s.registerDevice(tx, r, shopID, in)
		return err
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, c)
}

/* ───────── devices ───────── */

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	d := who(r).Device
	rows, err := s.DB.Query(r.Context(), `SELECT id, idx, name, kind, created_at, last_seen_at FROM devices WHERE shop_id = $1 AND revoked_at IS NULL ORDER BY idx`, d.ShopID)
	if err != nil {
		writeErr(w, err)
		return
	}
	type out struct {
		ID       string     `json:"id"`
		Index    int        `json:"index"`
		Name     string     `json:"name"`
		Kind     string     `json:"kind"`
		Created  time.Time  `json:"createdAt"`
		LastSeen *time.Time `json:"lastSeenAt"`
		This     bool       `json:"thisDevice"`
	}
	list := []out{}
	for rows.Next() {
		var o out
		if err := rows.Scan(&o.ID, &o.Index, &o.Name, &o.Kind, &o.Created, &o.LastSeen); err != nil {
			writeErr(w, err)
			return
		}
		o.This = o.ID == d.ID
		list = append(list, o)
	}
	writeJSON(w, 200, map[string]any{"devices": list})
}

func (s *Server) renameDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in, 64<<10); err != nil {
		writeErr(w, err)
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeErr(w, bad("Enter a name."))
		return
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE devices SET name = $1 WHERE id = $2 AND shop_id = $3`, strings.TrimSpace(in.Name), r.PathValue("id"), who(r).Device.ShopID)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, &httpError{404, "Device not found."})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	tag, err := s.DB.Exec(r.Context(), `UPDATE devices SET revoked_at = now() WHERE id = $1 AND shop_id = $2 AND revoked_at IS NULL`, r.PathValue("id"), who(r).Device.ShopID)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, &httpError{404, "Device not found."})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
