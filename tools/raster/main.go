package main

import (
	"fmt"
	"math"
	"math/big"
	"os"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: BalloonistRaster <request.txt> <result.json>")
		os.Exit(2)
	}
	reqPath, resPath := os.Args[1], os.Args[2]

	img, dump, mode := "", "", "frames"
	scale, pad, hFrac := 2.0, 0.035, 0.35
	minSide, minArea, maxAspect, maxAreaFrac, minRingInk := 30.0, 1500.0, 6.0, 0.18, 0.30
	whiteFrac, minRectFill := 0.985, 0.0
	thr, dil, lightThr := 200, 1, 205
	minFill := 0.55
	var rects []Rect

	raw, err := os.ReadFile(reqPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read request: "+err.Error())
		os.Exit(4)
	}
	body := strings.TrimPrefix(string(raw), "\ufeff")
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(line[:eq]))
		v := strings.TrimSpace(line[eq+1:])
		switch k {
		case "img":
			img = v
		case "dump":
			dump = v
		case "thr":
			thr = int(parseF(v))
		case "dil":
			dil = int(parseF(v))
		case "h":
			hFrac = parseF(v)
		case "scale":
			scale = parseF(v)
		case "pad":
			pad = parseF(v)
		case "mode":
			mode = strings.ToLower(v)
		case "minside":
			minSide = parseF(v)
		case "minarea":
			minArea = parseF(v)
		case "maxaspect":
			maxAspect = parseF(v)
		case "maxarea":
			maxAreaFrac = parseF(v)
		case "ring":
			minRingInk = parseF(v)
		case "wfrac":
			whiteFrac = parseF(v)
		case "rfill":
			minRectFill = parseF(v)
		case "lthr":
			lightThr = int(parseF(v))
		case "fillrate":
			minFill = parseF(v)
		case "rect":
			p := strings.Split(v, ",")
			if len(p) != 4 {
				continue
			}
			// the page points are scaled with the scale known *at this line*,
			// exactly like the .NET parser did (order of lines matters)
			rects = append(rects, Rect{
				x1: parseF(p[0]) * scale,
				y1: parseF(p[1]) * scale,
				x2: parseF(p[2]) * scale,
				y2: parseF(p[3]) * scale,
			})
		}
	}
	if img == "" || (len(rects) == 0 && mode != "bubbles" && mode != "blobs") {
		fmt.Fprintln(os.Stderr, "bad request: img or rect missing")
		os.Exit(3)
	}

	s_scale = scale

	if err := loadLum(img, thr); err != nil {
		fmt.Fprintln(os.Stderr, "cannot read image: "+err.Error())
		os.Exit(5)
	}
	for it := 0; it < dil; it++ {
		ErodeWhite()
	}
	LabelComponents()

	var out strings.Builder
	var bubbles []Result
	switch mode {
	case "blobs":
		bubbles = Blobs(pad, scale, minSide*scale, minArea*scale*scale,
			maxAspect, maxAreaFrac*float64(W)*float64(H), minFill, lightThr, dil)
		out.WriteString("{\"mode\":\"blobs\",\"bubbles\":[")
	case "bubbles":
		pageArea := float64(W) * float64(H)
		/* minside / minarea arrive in page points, the analysis runs in pixels */
		bubbles = Bubbles(pad, hFrac, scale, minSide*scale, minArea*scale*scale,
			maxAspect, maxAreaFrac*pageArea, minRingInk, minRectFill)
		out.WriteString("{\"mode\":\"bubbles\",\"bubbles\":[")
	default:
		out.WriteString("{\"results\":[")
		for n := 0; n < len(rects); n++ {
			if n > 0 {
				out.WriteString(",")
			}
			var r Result
			if mode == "box" {
				r = DetectBox(rects[n], pad, scale, whiteFrac)
			} else {
				r = DetectLocal(rects[n], pad, hFrac, scale)
			}
			out.WriteString(toJSON(r))
		}
		out.WriteString("]}")
	}
	if mode == "blobs" || mode == "bubbles" {
		for i := 0; i < len(bubbles); i++ {
			if i > 0 {
				out.WriteString(",")
			}
			out.WriteString(toJSON(bubbles[i]))
		}
		out.WriteString("]}")
	}

	// UTF-8 without BOM: the plugin reads it with B.json.read
	if err := os.WriteFile(resPath, []byte(out.String()), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "cannot write result: "+err.Error())
		os.Exit(6)
	}

	if dump != "" && (mode == "blobs" || mode == "bubbles") {
		if err := writeBubbleDump(img, dump, bubbles); err != nil {
			fmt.Fprintln(os.Stderr, "dump failed: "+err.Error())
		}
	}
	/* frames mode never drew a dump in the .NET build: the overlay hook was
	   only wired into the old global detector, which is no longer reachable */
}

func parseF(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}

// --------------------------------------------------------------- json

// N mirrors C#'s v.ToString("0.###", InvariantCulture): at most three
// decimals, trailing zeros dropped, never an exponent. .NET Framework first
// folds the double to 15 significant digits (so 1.3124999999999991 prints as
// 1.3125) and only then rounds the third decimal away from zero - both steps
// are done here in exact rational arithmetic to stay bit-identical.
func N(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.IsInf(v, 1) {
		return "Infinity"
	}
	if math.IsInf(v, -1) {
		return "-Infinity"
	}
	r := new(big.Rat).SetFloat64(v)
	if r == nil {
		return "0"
	}
	r = roundSig(r, 15)
	q := ratRoundHalfAway(new(big.Rat).Mul(r, ratPow10(3)))

	neg := q.Sign() < 0
	digits := new(big.Int).Abs(q).String()
	for len(digits) <= 3 {
		digits = "0" + digits
	}
	whole := digits[:len(digits)-3]
	frac := strings.TrimRight(digits[len(digits)-3:], "0")
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	b.WriteString(whole)
	if frac != "" {
		b.WriteByte('.')
		b.WriteString(frac)
	}
	return b.String()
}

// ratPow10 is 10^n as an exact rational (n may be negative).
func ratPow10(n int) *big.Rat {
	if n >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil))
	}
	return new(big.Rat).SetFrac(big.NewInt(1), new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-n)), nil))
}

// ratRoundHalfAway rounds to the nearest integer, ties away from zero.
func ratRoundHalfAway(r *big.Rat) *big.Int {
	num, den := r.Num(), r.Denom()
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(num, den, rem)
	if new(big.Int).Lsh(new(big.Int).Abs(rem), 1).Cmp(den) >= 0 {
		if num.Sign() < 0 {
			q.Sub(q, big.NewInt(1))
		} else {
			q.Add(q, big.NewInt(1))
		}
	}
	return q
}

// roundSig keeps sig significant decimal digits (ties away from zero).
func roundSig(r *big.Rat, sig int) *big.Rat {
	if r.Sign() == 0 {
		return new(big.Rat)
	}
	av := new(big.Rat).Abs(r)
	k := sig - 1 - decExponent(av)
	scaled := new(big.Rat).Mul(av, ratPow10(k))
	out := new(big.Rat).Mul(new(big.Rat).SetInt(ratRoundHalfAway(scaled)), ratPow10(-k))
	if r.Sign() < 0 {
		out.Neg(out)
	}
	return out
}

// decExponent is floor(log10(v)) for v > 0.
func decExponent(v *big.Rat) int {
	f := new(big.Float).SetPrec(256).SetRat(v)
	fv, _ := f.Float64()
	e := 0
	if fv > 0 && !math.IsInf(fv, 0) {
		e = int(math.Floor(math.Log10(fv)))
	} else {
		e = int(float64(f.MantExp(nil)) * 0.301029995663981195)
	}
	for {
		if new(big.Rat).Mul(v, ratPow10(-e)).Cmp(big.NewRat(1, 1)) < 0 {
			e--
			continue
		}
		if new(big.Rat).Mul(v, ratPow10(-e-1)).Cmp(big.NewRat(1, 1)) >= 0 {
			e++
			continue
		}
		return e
	}
}
func arr(a []float64) string {
	var b strings.Builder
	b.WriteByte('[')
	for i := 0; i < len(a); i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(N(a[i]))
	}
	b.WriteByte(']')
	return b.String()
}

func toJSON(r Result) string {
	var b strings.Builder
	b.WriteString("{\"ok\":")
	b.WriteString(boolStr(r.ok))
	b.WriteString(",\"leak\":")
	b.WriteString(boolStr(r.leak))
	b.WriteString(",\"area\":")
	b.WriteString(strconv.FormatInt(r.area, 10))
	b.WriteString(",\"center\":")
	b.WriteString(arr(r.center[:]))
	b.WriteString(",\"radius\":")
	b.WriteString(N(r.radius))
	b.WriteString(",\"bbox\":")
	b.WriteString(arr(r.bbox[:]))
	b.WriteString(",\"fitRect\":")
	b.WriteString(arr(r.fitRect[:]))
	b.WriteString(",\"fitInk\":")
	b.WriteString(N(r.fitInk))
	b.WriteString(",\"dbg\":\"")
	b.WriteString(strings.ReplaceAll(strings.ReplaceAll(r.dbg, "\\", "\\\\"), "\"", "\\\""))
	b.WriteString("\",\"poly\":[")
	for i := 0; i < len(r.poly); i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(arr(r.poly[i][:]))
	}
	b.WriteString("]}")
	return b.String()
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
