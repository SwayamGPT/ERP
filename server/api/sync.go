package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// Tables a device may sync (apps/desktop/src/db/sync/tables.ts).
var syncTables = map[string]bool{
	"company": true, "users": true, "parties": true, "items": true, "item_units": true, "batches": true,
	"employees": true, "expense_categories": true, "recurring_expenses": true, "invoices": true, "invoice_lines": true,
	"expenses": true, "money_moves": true, "payments": true, "ledger_entries": true, "stock_moves": true,
	"staff_requests": true, "audit_log": true, "sale_orders": true, "sale_order_lines": true,
	"purchase_orders": true, "purchase_order_lines": true, "godowns": true, "stock_transfers": true, "bank_lines": true,
	"cheques": true, "price_lists": true, "price_list_items": true, "loyalty_moves": true, "coupons": true, "coupon_uses": true,
	"reminders": true, "attachments": true, "gstr2b_rows": true, "payment_allocations": true, "recurring_skips": true, "coupon_moves": true, "bank_accounts": true, "deposits": true, "quotations": true, "quotation_lines": true,
}

const (
	maxPushChanges = 6000
	maxPushBytes   = 32 << 20
	defaultPull    = 1000
	maxPull        = 5000
)

type change struct {
	T  string          `json:"t"`
	ID int64           `json:"id"`
	D  bool            `json:"d,omitempty"`
	R  json.RawMessage `json:"r,omitempty"`
	X  int64           `json:"x"`
}

type pushIn struct {
	Changes  []change `json:"changes"`
	Snapshot bool     `json:"snapshot"`
}

type voucherKey struct{ typ, id string }

// push stores a batch of a device's changes in one transaction, after checking them:
// known tables, new rows inside the device's id block, invoice lines whose taxes add up,
// and (outside the first upload) every touched voucher balancing to the paisa.
func (s *Server) push(w http.ResponseWriter, r *http.Request) {
	d := who(r).Device
	var in pushIn
	if err := readJSON(r, &in, maxPushBytes); err != nil {
		writeErr(w, err)
		return
	}
	if len(in.Changes) > maxPushChanges {
		writeErr(w, bad("Too many changes in one push (%d, max %d).", len(in.Changes), maxPushChanges))
		return
	}
	vouchers := map[voucherKey]bool{}
	tbls := make([]string, 0, len(in.Changes))
	ids := make([]int64, 0, len(in.Changes))
	for _, c := range in.Changes {
		if !syncTables[c.T] {
			writeErr(w, &httpError{422, fmt.Sprintf("Table %q is not synced.", c.T)})
			return
		}
		if c.D {
			tbls, ids = append(tbls, c.T), append(ids, c.ID)
			continue
		}
		if len(c.R) == 0 {
			writeErr(w, &httpError{422, fmt.Sprintf("%s %d has no data.", c.T, c.ID)})
			return
		}
		row, err := decodeRow(c.R)
		if err != nil {
			writeErr(w, &httpError{422, fmt.Sprintf("%s %d: %v", c.T, c.ID, err)})
			return
		}
		if err := checkRow(c.T, c.ID, row); err != nil {
			writeErr(w, err)
			return
		}
		if c.T == "ledger_entries" && !in.Snapshot {
			vouchers[voucherKey{str(row["voucher_type"]), str(row["voucher_id"])}] = true
		}
		tbls, ids = append(tbls, c.T), append(ids, c.ID)
	}

	var seq int64
	err := inTx(r.Context(), s.DB, func(tx pgx.Tx) error {
		// One writer per shop at a time, so the feed's sequence numbers commit in order and a
		// device that pulls never skips a change that commits later with a smaller number.
		if err := tx.QueryRow(r.Context(), `SELECT seq FROM shops WHERE id = $1 FOR UPDATE`, d.ShopID).Scan(&seq); err != nil {
			return err
		}
		existing := map[string]bool{}
		rows, err := tx.Query(r.Context(), `SELECT r.tbl, r.id FROM rows r JOIN unnest($2::text[], $3::bigint[]) AS u(tbl, id) ON r.tbl = u.tbl AND r.id = u.id WHERE r.shop_id = $1`, d.ShopID, tbls, ids)
		if err != nil {
			return err
		}
		for rows.Next() {
			var t string
			var id int64
			if err := rows.Scan(&t, &id); err != nil {
				return err
			}
			existing[fmt.Sprintf("%s:%d", t, id)] = true
		}
		rows.Close()
		lo, hi := int64(d.Index)*IDBlock, int64(d.Index+1)*IDBlock
		batch := &pgx.Batch{}
		for _, c := range in.Changes {
			key := fmt.Sprintf("%s:%d", c.T, c.ID)
			if !existing[key] && !c.D && (c.ID < lo || c.ID >= hi) {
				return &httpError{422, fmt.Sprintf("New %s row %d is outside this device's id range. Reconnect this device.", c.T, c.ID)}
			}
			seq++
			var data any
			if !c.D {
				data = string(c.R)
			}
			batch.Queue(`INSERT INTO rows (shop_id, tbl, id, data, deleted, seq, device_id, txn) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
				ON CONFLICT (shop_id, tbl, id) DO UPDATE SET data = EXCLUDED.data, deleted = EXCLUDED.deleted, seq = EXCLUDED.seq,
				device_id = EXCLUDED.device_id, txn = EXCLUDED.txn, updated_at = now()`,
				d.ShopID, c.T, c.ID, data, c.D, seq, d.ID, c.X)
		}
		if err := tx.SendBatch(r.Context(), batch).Close(); err != nil {
			return err
		}
		for v := range vouchers {
			var diff int64
			err := tx.QueryRow(r.Context(), `SELECT COALESCE(SUM((data->>'debit')::bigint - (data->>'credit')::bigint), 0) FROM rows
				WHERE shop_id = $1 AND tbl = 'ledger_entries' AND NOT deleted AND data->>'voucher_type' = $2 AND data->>'voucher_id' = $3`, d.ShopID, v.typ, v.id).Scan(&diff)
			if err != nil {
				return err
			}
			if diff != 0 {
				return &httpError{422, fmt.Sprintf("Voucher %s %s does not balance (off by %d paise).", v.typ, v.id, diff)}
			}
		}
		_, err = tx.Exec(r.Context(), `UPDATE shops SET seq = $2 WHERE id = $1`, d.ShopID, seq)
		return err
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"seq": seq, "stored": len(in.Changes)})
}

type pulledRow struct {
	T   string          `json:"t"`
	ID  int64           `json:"id"`
	D   bool            `json:"d,omitempty"`
	R   json.RawMessage `json:"r,omitempty"`
	X   int64           `json:"x"`
	Seq int64           `json:"seq"`
}

// pull returns the shop's changes after `since`, in order, minus this device's own writes.
func (s *Server) pull(w http.ResponseWriter, r *http.Request) {
	d := who(r).Device
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = defaultPull
	}
	if limit > maxPull {
		limit = maxPull
	}
	rows, err := s.DB.Query(r.Context(), `SELECT tbl, id, data, deleted, seq, device_id, txn FROM rows WHERE shop_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, d.ShopID, since, limit+1)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer rows.Close()
	out := []pulledRow{}
	cursor, n, more := since, 0, false
	for rows.Next() {
		if n == limit {
			more = true
			break
		}
		n++
		var p pulledRow
		var data []byte
		var dev string
		if err := rows.Scan(&p.T, &p.ID, &data, &p.D, &p.Seq, &dev, &p.X); err != nil {
			writeErr(w, err)
			return
		}
		cursor = p.Seq
		if dev == d.ID {
			continue
		}
		if !p.D {
			p.R = data
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"rows": out, "seq": cursor, "more": more})
}

/* ───────── row checks ───────── */

func decodeRow(raw json.RawMessage) (map[string]any, error) {
	var m map[string]any
	dec := json.NewDecoder(bytesReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("not a JSON object")
	}
	return m, nil
}

func checkRow(table string, id int64, row map[string]any) error {
	if v, ok := row["id"]; ok {
		if n, ok := toInt(v); !ok || n != id {
			return &httpError{422, fmt.Sprintf("%s %d: id in the row does not match.", table, id)}
		}
	}
	if table == "invoice_lines" {
		get := func(k string) int64 { n, _ := toInt(row[k]); return n }
		if get("taxable")+get("cgst")+get("sgst")+get("igst")+get("cess") != get("total") {
			return &httpError{422, fmt.Sprintf("Bill line %d: taxable value plus taxes does not equal the line total.", id)}
		}
	}
	if table == "ledger_entries" {
		dr, ok1 := toInt(row["debit"])
		cr, ok2 := toInt(row["credit"])
		if !ok1 || !ok2 || dr < 0 || cr < 0 {
			return &httpError{422, fmt.Sprintf("Ledger entry %d: debit and credit must be whole paise, not negative.", id)}
		}
	}
	return nil
}

func toInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
		if f, err := n.Float64(); err == nil && f == float64(int64(f)) {
			return int64(f), true
		}
	case nil:
		return 0, true
	}
	return 0, false
}

func str(v any) string {
	switch n := v.(type) {
	case json.Number:
		return n.String()
	case string:
		return n
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}
