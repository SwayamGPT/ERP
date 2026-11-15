package gst

import (
	"encoding/json"
	"os"
	"testing"
)

// The same golden vectors the TypeScript core is tested with.
func TestGoldenFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../packages/core/fixtures/gst-lines.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name string    `json:"name"`
			In   LineInput `json:"in"`
			Out  LineTax   `json:"out"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range f.Cases {
		got := ComputeLine(c.In)
		w := c.Out
		if got.Taxable != w.Taxable || got.Cgst != w.Cgst || got.Sgst != w.Sgst || got.Igst != w.Igst || got.Cess != w.Cess || got.Total != w.Total {
			t.Errorf("%s: got %+v want %+v", c.Name, got, w)
		}
		if got.Taxable+got.Cgst+got.Sgst+got.Igst+got.Cess != got.Total {
			t.Errorf("%s: taxable + taxes != total", c.Name)
		}
	}
}
