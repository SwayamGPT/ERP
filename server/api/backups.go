package api

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	maxBackupBytes = 512 << 20
	keepBackups    = 30
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

// The body is an already-encrypted snapshot (AES-GCM on the device). The server stores bytes only.
func (s *Server) uploadBackup(w http.ResponseWriter, r *http.Request) {
	d := who(r).Device
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBackupBytes))
	if err != nil {
		writeErr(w, bad("Backup too large or interrupted."))
		return
	}
	if len(data) < 32 || !bytes.HasPrefix(data, []byte("HSB1")) {
		writeErr(w, bad("This is not an encrypted Hisaab backup."))
		return
	}
	id := newID("bak")
	note := r.Header.Get("X-Hisaab-Note")
	if len(note) > 200 {
		note = note[:200]
	}
	if _, err := s.DB.Exec(r.Context(), `INSERT INTO backups (id, shop_id, device_id, note, size, data) VALUES ($1, $2, $3, $4, $5, $6)`, id, d.ShopID, d.ID, note, len(data), data); err != nil {
		writeErr(w, err)
		return
	}
	_, _ = s.DB.Exec(r.Context(), `DELETE FROM backups WHERE shop_id = $1 AND id NOT IN (SELECT id FROM backups WHERE shop_id = $1 ORDER BY created_at DESC LIMIT $2)`, d.ShopID, keepBackups)
	writeJSON(w, 201, map[string]any{"id": id, "size": len(data)})
}

// shopFor returns the shop a request may read backups of: the device's own, or (for an owner signed in
// on a new computer) the ?shop= they own.
func (s *Server) shopFor(r *http.Request) (string, error) {
	p := who(r)
	if p.Device != nil {
		return p.Device.ShopID, nil
	}
	shop := r.URL.Query().Get("shop")
	var owner string
	if err := s.DB.QueryRow(r.Context(), `SELECT owner_id FROM shops WHERE id = $1`, shop).Scan(&owner); err != nil || owner != p.AccountID {
		return "", &httpError{404, "Shop not found."}
	}
	return shop, nil
}

func (s *Server) listBackups(w http.ResponseWriter, r *http.Request) {
	shop, err := s.shopFor(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT b.id, b.note, b.size, b.created_at, COALESCE(d.name, '') FROM backups b LEFT JOIN devices d ON d.id = b.device_id
		WHERE b.shop_id = $1 ORDER BY b.created_at DESC`, shop)
	if err != nil {
		writeErr(w, err)
		return
	}
	type out struct {
		ID      string    `json:"id"`
		Note    *string   `json:"note"`
		Size    int64     `json:"size"`
		Created time.Time `json:"createdAt"`
		Device  string    `json:"device"`
	}
	list := []out{}
	for rows.Next() {
		var o out
		if err := rows.Scan(&o.ID, &o.Note, &o.Size, &o.Created, &o.Device); err != nil {
			writeErr(w, err)
			return
		}
		list = append(list, o)
	}
	writeJSON(w, 200, map[string]any{"backups": list})
}

func (s *Server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	shop, err := s.shopFor(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var data []byte
	if err := s.DB.QueryRow(r.Context(), `SELECT data FROM backups WHERE id = $1 AND shop_id = $2`, r.PathValue("id"), shop).Scan(&data); err != nil {
		writeErr(w, &httpError{404, "Backup not found."})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}
