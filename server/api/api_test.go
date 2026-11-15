package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// Integration tests against a real Postgres. Set HISAAB_TEST_DB, e.g.
// postgres://hisaab:hisaab@localhost:5432/hisaab_test (the database is wiped).
func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	dsn := os.Getenv("HISAAB_TEST_DB")
	if dsn == "" {
		t.Skip("HISAAB_TEST_DB not set")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(ctx, `TRUNCATE accounts, sessions, shops, devices, pairing_codes, rows, backups CASCADE`); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { ts.Close(); s.DB.Close() })
	return ts
}

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c client) do(method, path string, body any, out any) int {
	c.t.Helper()
	var rd io.Reader
	if b, ok := body.([]byte); ok {
		rd = bytes.NewReader(b)
	} else if body != nil {
		j, _ := json.Marshal(body)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if out != nil {
		if p, ok := out.(*[]byte); ok {
			*p = raw
		} else if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: %v (%s)", method, path, err, raw)
		}
	}
	return res.StatusCode
}

type creds struct {
	ShopID, DeviceID, DeviceToken string
	DeviceIndex                   int
}

func setupShop(t *testing.T, ts *httptest.Server) (owner client, shop string, d0, d1 client, c1 creds) {
	anon := client{t, ts.URL, ""}
	var sess struct{ Token string }
	if st := anon.do("POST", "/v1/auth/signup", map[string]string{"email": "Owner@Shop.in", "password": "secret123"}, &sess); st != 200 {
		t.Fatalf("signup %d", st)
	}
	var e struct{ Error string }
	if st := anon.do("POST", "/v1/auth/signup", map[string]string{"email": "owner@shop.in", "password": "secret123"}, &e); st != 409 {
		t.Fatalf("duplicate signup %d", st)
	}
	if st := anon.do("POST", "/v1/auth/login", map[string]string{"email": "owner@shop.in", "password": "nope-nope"}, &e); st != 401 {
		t.Fatalf("bad login %d", st)
	}
	if st := anon.do("POST", "/v1/auth/login", map[string]string{"email": "owner@shop.in", "password": "secret123"}, &sess); st != 200 {
		t.Fatalf("login %d", st)
	}
	owner = client{t, ts.URL, sess.Token}
	var sh struct{ ID string }
	owner.do("POST", "/v1/shops", map[string]string{"name": "Sharma Kirana"}, &sh)
	var c0 creds
	if st := owner.do("POST", "/v1/shops/"+sh.ID+"/devices", map[string]string{"name": "Main counter"}, &c0); st != 201 || c0.DeviceIndex != 0 {
		t.Fatalf("first device %d %+v", st, c0)
	}
	d0 = client{t, ts.URL, c0.DeviceToken}
	var code struct{ Code string }
	d0.do("POST", "/v1/pairing-codes", nil, &code)
	if len(code.Code) != 6 {
		t.Fatalf("code %q", code.Code)
	}
	if st := anon.do("POST", "/v1/devices/pair", map[string]string{"code": code.Code, "name": "Counter 2"}, &c1); st != 201 || c1.DeviceIndex != 1 || c1.ShopID != sh.ID {
		t.Fatalf("pair %d %+v", st, c1)
	}
	if st := anon.do("POST", "/v1/devices/pair", map[string]string{"code": code.Code, "name": "Again"}, &e); st != 400 {
		t.Fatalf("code reused: %d", st)
	}
	return owner, sh.ID, d0, client{t, ts.URL, c1.DeviceToken}, c1
}

func row(t string, id int64, r map[string]any) map[string]any {
	r["id"] = id
	return map[string]any{"t": t, "id": id, "r": r, "x": 1}
}

func TestSyncFlow(t *testing.T) {
	ts := testServer(t)
	_, _, d0, d1, _ := setupShop(t, ts)

	// Device 0's first upload, then a balanced sale from device 1 (ids in its own block).
	var out struct {
		Seq   int64
		Error string
	}
	snap := []any{
		row("company", 1, map[string]any{"name": "Sharma Kirana"}),
		row("items", 5, map[string]any{"name": "Sugar", "barcode": nil}),
	}
	if st := d0.do("POST", "/v1/sync/push", map[string]any{"changes": snap, "snapshot": true}, &out); st != 200 || out.Seq != 2 {
		t.Fatalf("snapshot push %d %+v", st, out)
	}
	b := IDBlock
	sale := []any{
		row("invoices", b+1, map[string]any{"number": "INV-B-1", "total": 10500}),
		row("invoice_lines", b+2, map[string]any{"invoice_id": b + 1, "taxable": 10000, "cgst": 250, "sgst": 250, "igst": 0, "cess": 0, "total": 10500}),
		row("ledger_entries", b+3, map[string]any{"voucher_type": "sale", "voucher_id": b + 1, "debit": 10500, "credit": 0}),
		row("ledger_entries", b+4, map[string]any{"voucher_type": "sale", "voucher_id": b + 1, "debit": 0, "credit": 10000}),
		row("ledger_entries", b+5, map[string]any{"voucher_type": "sale", "voucher_id": b + 1, "debit": 0, "credit": 500}),
		row("items", 5, map[string]any{"name": "Sugar 1kg"}), // edit of a row device 0 created
	}
	if st := d1.do("POST", "/v1/sync/push", map[string]any{"changes": sale}, &out); st != 200 {
		t.Fatalf("sale push %d %+v", st, out)
	}

	// Rejections leave nothing behind.
	reject := func(name string, changes []any) {
		t.Helper()
		var e struct{ Error string }
		if st := d1.do("POST", "/v1/sync/push", map[string]any{"changes": changes}, &e); st != 422 {
			t.Fatalf("%s: want 422, got %d (%s)", name, st, e.Error)
		}
	}
	reject("unbalanced voucher", []any{
		row("ledger_entries", b+10, map[string]any{"voucher_type": "sale", "voucher_id": b + 9, "debit": 100, "credit": 0}),
		row("ledger_entries", b+11, map[string]any{"voucher_type": "sale", "voucher_id": b + 9, "debit": 0, "credit": 99}),
	})
	reject("id outside device block", []any{row("parties", 77, map[string]any{"name": "X"})})
	reject("line taxes don't add up", []any{row("invoice_lines", b+12, map[string]any{"taxable": 100, "cgst": 3, "sgst": 3, "total": 105})})
	reject("unknown table", []any{row("settings", b+13, map[string]any{})})

	// Device 0 pulls: sees device 1's work (and its edit) but not its own snapshot.
	var page struct {
		Rows []struct {
			T   string
			ID  int64
			D   bool
			R   map[string]any
			Seq int64
		}
		Seq  int64
		More bool
	}
	d0.do("GET", "/v1/sync/pull?since=0&limit=100", nil, &page)
	if len(page.Rows) != 6 || page.More {
		t.Fatalf("pull: %d rows more=%v", len(page.Rows), page.More)
	}
	for _, r := range page.Rows {
		if r.T == "company" {
			t.Fatal("own rows must not echo back")
		}
		if r.T == "items" && r.R["name"] != "Sugar 1kg" {
			t.Fatalf("edit not latest: %+v", r.R)
		}
	}
	// Pagination: small pages, cursor advances past own rows, and the latest state is compacted.
	var all int
	since := int64(0)
	for i := 0; i < 20; i++ {
		d1.do("GET", fmt.Sprintf("/v1/sync/pull?since=%d&limit=2", since), nil, &page)
		all += len(page.Rows)
		since = page.Seq
		if !page.More {
			break
		}
	}
	if all != 2-1 { // company only: items row 5 was last written by device 1 itself
		t.Fatalf("device 1 pulled %d rows", all)
	}

	// Deletes travel as tombstones.
	d0.do("POST", "/v1/sync/push", map[string]any{"changes": []any{map[string]any{"t": "items", "id": 5, "d": true, "x": 2}}}, &out)
	d1.do("GET", fmt.Sprintf("/v1/sync/pull?since=%d", since), nil, &page)
	if len(page.Rows) != 1 || !page.Rows[0].D {
		t.Fatalf("tombstone: %+v", page.Rows)
	}
}

func TestBackupsAndRevoke(t *testing.T) {
	ts := testServer(t)
	owner, shop, d0, d1, c1 := setupShop(t, ts)
	blob := append([]byte("HSB1"), bytes.Repeat([]byte{7}, 100)...)
	var up struct{ ID string }
	if st := d0.do("POST", "/v1/backups", blob, &up); st != 201 {
		t.Fatalf("upload %d", st)
	}
	var e struct{ Error string }
	if st := d0.do("POST", "/v1/backups", []byte("SQLite format 3 plain text is refused"), &e); st != 400 {
		t.Fatalf("plain upload %d", st)
	}
	// The owner, signed in on a new computer, lists and downloads it.
	var list struct{ Backups []struct{ ID string } }
	owner.do("GET", "/v1/backups?shop="+shop, nil, &list)
	if len(list.Backups) != 1 {
		t.Fatalf("list %+v", list)
	}
	var got []byte
	owner.do("GET", "/v1/backups/"+up.ID+"?shop="+shop, nil, &got)
	if !bytes.Equal(got, blob) {
		t.Fatal("download differs")
	}
	// Removing a device locks it out.
	if st := d0.do("DELETE", "/v1/devices/"+c1.DeviceID, nil, nil); st != 200 {
		t.Fatalf("revoke %d", st)
	}
	if st := d1.do("GET", "/v1/sync/pull", nil, &e); st != 401 {
		t.Fatalf("revoked device still works: %d", st)
	}
	var devs struct{ Devices []struct{ Name string } }
	d0.do("GET", "/v1/devices", nil, &devs)
	if len(devs.Devices) != 1 {
		t.Fatalf("devices %+v", devs)
	}
}
