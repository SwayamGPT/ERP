// Package gst is the server's copy of the line-tax rules in packages/core/src/gst.ts.
// Both must reproduce packages/core/fixtures/gst-lines.json to the paisa (see gst_test.go).
// All arithmetic is exact integer maths in paise; rates are basis points (5% = 500).
package gst

import "math"

type LineInput struct {
	Qty          float64 `json:"qty"`
	Rate         int64   `json:"rate"`
	DiscountPct  float64 `json:"discountPct"`
	DiscountAmt  int64   `json:"discountAmt"`
	GstRate      float64 `json:"gstRate"`
	CessRate     float64 `json:"cessRate"`
	TaxInclusive bool    `json:"taxInclusive"`
	InterState   bool    `json:"interState"`
}

type LineTax struct {
	Gross    int64 `json:"gross"`
	Discount int64 `json:"discount"`
	Taxable  int64 `json:"taxable"`
	Cgst     int64 `json:"cgst"`
	Sgst     int64 `json:"sgst"`
	Igst     int64 `json:"igst"`
	Cess     int64 `json:"cess"`
	Tax      int64 `json:"tax"`
	Total    int64 `json:"total"`
}

func bp(pct float64) int64 { return int64(math.Round(pct * 100)) }

// divHalfUp returns round-half-up(a / b) for a >= 0, b > 0.
func divHalfUp(a, b int64) int64 { return (2*a + b) / (2 * b) }

// LineGross is qty × rate on integer milli-units.
func LineGross(qty float64, rate int64) int64 {
	milli := int64(math.Round(qty * 1000))
	return divHalfUp(milli*rate, 1000)
}

func taxesOn(taxable, gstBp, cessBp int64, inter bool) (cgst, sgst, igst, cess int64) {
	cess = divHalfUp(taxable*cessBp, 10000)
	if inter {
		return 0, 0, divHalfUp(taxable*gstBp, 10000), cess
	}
	half := divHalfUp(taxable*gstBp, 20000)
	return half, half, 0, cess
}

// ComputeLine mirrors computeLine() in packages/core/src/gst.ts.
func ComputeLine(in LineInput) LineTax {
	gstBp, cessBp := bp(in.GstRate), bp(in.CessRate)
	gross := LineGross(in.Qty, in.Rate)
	discount := divHalfUp(gross*bp(in.DiscountPct), 10000) + in.DiscountAmt
	if discount > gross {
		discount = gross
	}
	net := gross - discount
	if !in.TaxInclusive {
		c, s, i, ce := taxesOn(net, gstBp, cessBp, in.InterState)
		tax := c + s + i + ce
		return LineTax{gross, discount, net, c, s, i, ce, tax, net + tax}
	}
	taxable0 := divHalfUp(net*10000, 10000+gstBp+cessBp)
	c, s, i, ce := taxesOn(taxable0, gstBp, cessBp, in.InterState)
	tax := c + s + i + ce
	return LineTax{gross, discount, net - tax, c, s, i, ce, tax, net}
}
