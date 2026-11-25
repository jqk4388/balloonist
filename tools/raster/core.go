package main

import (
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"math"
	"os"
)

/*
 * BalloonistRaster — speech-bubble geometry for Balloonist (InDesign).
 *
 * Pure Go, no third-party packages: the same pipeline the .NET build ran,
 * so Windows and macOS ship the identical analyser.
 *
 * Request file (one directive per line, '#' starts a comment):
 *   img=<exported page png>
 *   scale=<px per page point>                        (export dpi / 72)
 *   pad=<0..1, padding kept inside the bubble edge>   default 0.035
 *   thr=<0..255 luminance that counts as paper>       default 200
 *   dil=<ink dilation passes, seals anti-aliased gaps> default 1
 *   h=<0..1 of the local max distance used as h-maxima dome>  default 0.35
 *   dump=<path>.png                                  optional debug overlay
 *   rect=<x1,y1,x2,y2>                               page points, one per frame
 *
 * Result: {"results":[{ok,leak,area,center:[x,y],radius,bbox:[..],
 *                       fitRect:[..],fitInk,dbg:"...",poly:[[x,y],...]}]}
 */

var (
	W, H   int
	mask   []byte
	lumv   []byte
	labels []int
	comps  []Comp
)

type Comp struct {
	id, area              int
	minX, minY, maxX, maxY int
	sumX, sumY            int64
	touchesBorder         bool
}

func (c *Comp) Cx() float64 { return float64(c.sumX) / float64(c.area) }
func (c *Comp) Cy() float64 { return float64(c.sumY) / float64(c.area) }

// Rect is already in pixels (the parser multiplies the page points by scale).
type Rect struct {
	x1, y1, x2, y2 float64
}

func (r Rect) Cx() float64 { return (r.x1 + r.x2) / 2 }
func (r Rect) Cy() float64 { return (r.y1 + r.y2) / 2 }

type Result struct {
	ok, leak bool
	openRays int      // radial rays that escaped the ink outline
	fitInk   float64  // ink fraction inside the safe rectangle
	center   [2]float64
	radius   float64
	bbox     [4]float64
	fitRect  [4]float64
	area     int64
	dbg      string
	poly     [][2]float64
}

// ---------------------------------------------------------------- image load

// loadLum decodes the page and fills lumv/mask. A transparent PNG is composited
// over black the way GDI+ drew it onto the 24bpp canvas the .NET build used.
func loadLum(path string, thr int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	im, _, err := image.Decode(f)
	if err != nil {
		return err
	}
	b := im.Bounds()
	W, H = b.Dx(), b.Dy()
	lumv = make([]byte, W*H)
	mask = make([]byte, W*H)

	put := func(x, y, r, g, bl int) {
		i := y*W + x
		L := (r*2 + g*3 + bl) / 6
		lumv[i] = byte(L)
		if L >= thr {
			mask[i] = 1
		}
	}

	switch src := im.(type) {
	case *image.NRGBA:
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				i := src.PixOffset(x+b.Min.X, y+b.Min.Y)
				r, g, bl, a := int(src.Pix[i]), int(src.Pix[i+1]), int(src.Pix[i+2]), int(src.Pix[i+3])
				if a != 255 {
					r, g, bl = r*a/255, g*a/255, bl*a/255
				}
				put(x, y, r, g, bl)
			}
		}
	case *image.RGBA: // premultiplied by definition
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				i := src.PixOffset(x+b.Min.X, y+b.Min.Y)
				put(x, y, int(src.Pix[i]), int(src.Pix[i+1]), int(src.Pix[i+2]))
			}
		}
	case *image.Gray:
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				v := int(src.Pix[src.PixOffset(x+b.Min.X, y+b.Min.Y)])
				put(x, y, v, v, v)
			}
		}
	case *image.YCbCr:
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				yy, cb, cr := src.YCbCrAt(x+b.Min.X, y+b.Min.Y).Y, src.YCbCrAt(x+b.Min.X, y+b.Min.Y).Cb, src.YCbCrAt(x+b.Min.X, y+b.Min.Y).Cr
				r, g, bl := color.YCbCrToRGB(yy, cb, cr)
				put(x, y, int(r), int(g), int(bl))
			}
		}
	default:
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				c := color.NRGBA64Model.Convert(im.At(x+b.Min.X, y+b.Min.Y)).(color.NRGBA64)
				put(x, y, int(c.R>>8), int(c.G>>8), int(c.B>>8))
			}
		}
	}
	return nil
}

func decodeImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	im, _, err := image.Decode(f)
	return im, err
}

func savePNG(path string, im image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, im)
}

// -------------------------------------------------------------- morphology

// paper pixel survives only when all four neighbours are paper as well
func ErodeWhite() {
	tmp := make([]byte, W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			i := y*W + x
			if mask[i] == 0 {
				continue
			}
			if x == 0 || y == 0 || x == W-1 || y == H-1 {
				continue
			}
			if mask[i-1] == 1 && mask[i+1] == 1 && mask[i-W] == 1 && mask[i+W] == 1 {
				tmp[i] = 1
			}
		}
	}
	mask = tmp
}

func LabelComponents() {
	labels = make([]int, W*H)
	stack := make([]int, W*H)
	next := 0
	comps = comps[:0]
	for i := 0; i < W*H; i++ {
		if mask[i] == 0 || labels[i] != 0 {
			continue
		}
		next++
		c := Comp{id: next, minX: math.MaxInt32, minY: math.MaxInt32, maxX: -1, maxY: -1}
		sp := 0
		stack[sp] = i
		sp++
		labels[i] = next
		for sp > 0 {
			sp--
			p := stack[sp]
			x, y := p%W, p/W
			c.area++
			c.sumX += int64(x)
			c.sumY += int64(y)
			if x < c.minX {
				c.minX = x
			}
			if y < c.minY {
				c.minY = y
			}
			if x > c.maxX {
				c.maxX = x
			}
			if y > c.maxY {
				c.maxY = y
			}
			if x == 0 || y == 0 || x == W-1 || y == H-1 {
				c.touchesBorder = true
			}
			if x > 0 && mask[p-1] == 1 && labels[p-1] == 0 {
				labels[p-1] = next
				stack[sp] = p - 1
				sp++
			}
			if x < W-1 && mask[p+1] == 1 && labels[p+1] == 0 {
				labels[p+1] = next
				stack[sp] = p + 1
				sp++
			}
			if y > 0 && mask[p-W] == 1 && labels[p-W] == 0 {
				labels[p-W] = next
				stack[sp] = p - W
				sp++
			}
			if y < H-1 && mask[p+W] == 1 && labels[p+W] == 0 {
				labels[p+W] = next
				stack[sp] = p + W
				sp++
			}
		}
		comps = append(comps, c)
	}
}

// Dilate is the ink dilation used by the blob detector (4-neighbour).
func Dilate(m []bool) {
	tmp := make([]bool, len(m))
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			i := y*W + x
			if !m[i] {
				continue
			}
			tmp[i] = true
			if x > 0 {
				tmp[i-1] = true
			}
			if x < W-1 {
				tmp[i+1] = true
			}
			if y > 0 {
				tmp[i-W] = true
			}
			if y < H-1 {
				tmp[i+W] = true
			}
		}
	}
	copy(m, tmp)
}

// ------------------------------------------------------------- distance map

func fmin32(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func Chamfer(inside []bool, lw, lh int) []float32 {
	const INF float32 = 1e9
	sq := float32(1.41421356)
	d := make([]float32, lw*lh)
	for i := 0; i < len(d); i++ {
		if inside[i] {
			d[i] = INF
		} else {
			d[i] = 0
		}
	}
	for y := 0; y < lh; y++ {
		for x := 0; x < lw; x++ {
			i := y*lw + x
			if !inside[i] {
				continue
			}
			v := d[i]
			if x > 0 {
				v = fmin32(v, d[i-1]+1)
			}
			if y > 0 {
				v = fmin32(v, d[i-lw]+1)
			}
			if x > 0 && y > 0 {
				v = fmin32(v, d[i-lw-1]+sq)
			}
			if x < lw-1 && y > 0 {
				v = fmin32(v, d[i-lw+1]+sq)
			}
			d[i] = v
		}
	}
	for y := lh - 1; y >= 0; y-- {
		for x := lw - 1; x >= 0; x-- {
			i := y*lw + x
			if !inside[i] {
				continue
			}
			v := d[i]
			if x < lw-1 {
				v = fmin32(v, d[i+1]+1)
			}
			if y < lh-1 {
				v = fmin32(v, d[i+lw]+1)
			}
			if x < lw-1 && y < lh-1 {
				v = fmin32(v, d[i+lw+1]+sq)
			}
			if x > 0 && y < lh-1 {
				v = fmin32(v, d[i+lw-1]+sq)
			}
			d[i] = v
		}
	}
	return d
}

// -------------------------------------------------------------- flood fills

func Seed(outside []bool, stack []int, sp *int, inside []bool, lw, lh, x, y int) {
	if x < 0 || y < 0 || x >= lw || y >= lh {
		return
	}
	i := y*lw + x
	if inside[i] || outside[i] {
		return
	}
	outside[i] = true
	stack[*sp] = i
	*sp++
}

func InWin(x, y, lw, lh int) bool { return x >= 0 && y >= 0 && x < lw && y < lh }

func RegionTouchesBorder(region []bool, lw, lh int) bool {
	for x := 0; x < lw; x++ {
		if region[x] || region[(lh-1)*lw+x] {
			return true
		}
	}
	for y := 0; y < lh; y++ {
		if region[y*lw] || region[y*lw+lw-1] {
			return true
		}
	}
	return false
}

func FillHoles(region []bool, lw, lh int) {
	outside := make([]bool, lw*lh)
	q := make([]int, lw*lh)
	head, tail := 0, 0
	for x := 0; x < lw; x++ {
		if !region[x] && !outside[x] {
			outside[x] = true
			q[tail] = x
			tail++
		}
		bottom := (lh - 1) * lw
		bottom += x
		if !region[bottom] && !outside[bottom] {
			outside[bottom] = true
			q[tail] = bottom
			tail++
		}
	}
	for y := 0; y < lh; y++ {
		left := y * lw
		right := y*lw + lw - 1
		if !region[left] && !outside[left] {
			outside[left] = true
			q[tail] = left
			tail++
		}
		if !region[right] && !outside[right] {
			outside[right] = true
			q[tail] = right
			tail++
		}
	}
	for head < tail {
		cur := q[head]
		head++
		cx, cy := cur%lw, cur/lw
		nx := [4]int{cur - 1, cur + 1, cur - lw, cur + lw}
		ny := [4]int{cy, cy, cy - 1, cy + 1}
		nxx := [4]int{cx - 1, cx + 1, cx, cx}
		for k := 0; k < 4; k++ {
			if nx[k] < 0 || nx[k] >= len(q) || ny[k] < 0 || ny[k] >= lh || nxx[k] < 0 || nxx[k] >= lw {
				continue
			}
			if outside[nx[k]] || region[nx[k]] {
				continue
			}
			outside[nx[k]] = true
			q[tail] = nx[k]
			tail++
		}
	}
	for i := 0; i < len(region); i++ {
		if !region[i] && !outside[i] {
			region[i] = true
		}
	}
}

func Count(a []bool) int {
	n := 0
	for i := 0; i < len(a); i++ {
		if a[i] {
			n++
		}
	}
	return n
}

// --------------------------------------------------------------- max-heap

type floatHeap struct {
	keys []float32
	vals []int
	n    int
}

func newHeap(cap int) *floatHeap {
	return &floatHeap{keys: make([]float32, cap), vals: make([]int, cap)}
}

func (h *floatHeap) Count() int { return h.n }

func (h *floatHeap) grow() {
	c := len(h.keys) * 2
	k := make([]float32, c)
	v := make([]int, c)
	copy(k, h.keys)
	copy(v, h.vals)
	h.keys, h.vals = k, v
}

func (h *floatHeap) push(k float32, v int) {
	if h.n == len(h.keys) {
		h.grow()
	}
	i := h.n
	h.n++
	h.keys[i] = k
	h.vals[i] = v
	for i > 0 {
		pa := (i - 1) / 2
		if h.keys[pa] >= h.keys[i] {
			break
		}
		h.keys[pa], h.keys[i] = h.keys[i], h.keys[pa]
		h.vals[pa], h.vals[i] = h.vals[i], h.vals[pa]
		i = pa
	}
}

func (h *floatHeap) pop() (float32, int) {
	k, v := h.keys[0], h.vals[0]
	h.n--
	if h.n > 0 {
		h.keys[0] = h.keys[h.n]
		h.vals[0] = h.vals[h.n]
		i := 0
		for {
			l := 2*i + 1
			if l >= h.n {
				break
			}
			r, b := l+1, l
			if r < h.n && h.keys[r] > h.keys[l] {
				b = r
			}
			if h.keys[b] <= h.keys[i] {
				break
			}
			h.keys[i], h.keys[b] = h.keys[b], h.keys[i]
			h.vals[i], h.vals[b] = h.vals[b], h.vals[i]
			i = b
		}
	}
	return k, v
}

// ------------------------------------------------------------- union find

type UnionFind struct{ p []int }

func NewUnionFind(n int) *UnionFind {
	uf := &UnionFind{p: make([]int, n)}
	for i := 0; i < n; i++ {
		uf.p[i] = i
	}
	return uf
}

func (u *UnionFind) Count() int { return len(u.p) }

func (u *UnionFind) Find(x int) int {
	for u.p[x] != x {
		u.p[x] = u.p[u.p[x]]
		x = u.p[x]
	}
	return x
}

func (u *UnionFind) Union(a, b int) {
	ra, rb := u.Find(a), u.Find(b)
	if ra != rb {
		u.p[rb] = ra
	}
}

// --------------------------------------------------------------- saddles

// saddleSet keeps the C# Dictionary's insertion order, so MergeBasins()
// resolves the same way the .NET build did.
type saddleSet struct {
	keys []int64
	vals []float32
	pos  map[int64]int
}

func newSaddleSet() *saddleSet {
	return &saddleSet{pos: map[int64]int{}}
}

func (s *saddleSet) set(k int64, v float32) {
	if i, ok := s.pos[k]; ok {
		s.vals[i] = v
		return
	}
	s.pos[k] = len(s.keys)
	s.keys = append(s.keys, k)
	s.vals = append(s.vals, v)
}

func (s *saddleSet) get(k int64) (float32, bool) {
	i, ok := s.pos[k]
	if !ok {
		return 0, false
	}
	return s.vals[i], true
}

func (s *saddleSet) len() int { return len(s.keys) }

// ------------------------------------------------------------ h-maxima

func RelaxRec(rec []float32, heap *floatHeap, d []float32, lw, lh, p, x, y int) {
	if x < 0 || y < 0 || x >= lw || y >= lh {
		return
	}
	q := y*lw + x
	v := fmin32(d[q], rec[p])
	if v > rec[q]+0.01 {
		rec[q] = v
		heap.push(v, q)
	}
}

// HMaximaSeeds returns one seed per dome: a tail or a waist cannot spawn one.
func HMaximaSeeds(d []float32, inside []bool, lw, lh int, h float32) (reps []int, cMax []float32) {
	if len(d) == 0 {
		return nil, nil
	}
	rec := make([]float32, len(d))
	heap := newHeap(1 << 12)
	for i := 0; i < len(d); i++ {
		if !inside[i] {
			continue
		}
		m := d[i] - h
		if m <= 0 {
			continue
		}
		rec[i] = m
		heap.push(m, i)
	}
	for heap.Count() > 0 {
		key, p := heap.pop()
		if key < rec[p] {
			continue
		}
		x, y := p%lw, p/lw
		RelaxRec(rec, heap, d, lw, lh, p, x-1, y)
		RelaxRec(rec, heap, d, lw, lh, p, x+1, y)
		RelaxRec(rec, heap, d, lw, lh, p, x, y-1)
		RelaxRec(rec, heap, d, lw, lh, p, x, y+1)
	}

	lab := make([]int, lw*lh)
	stack := make([]int, lw*lh)
	next := 0
	for i := 0; i < len(d); i++ {
		if !inside[i] || lab[i] != 0 {
			continue
		}
		if d[i]-rec[i] <= 0.5 {
			continue
		}
		next++
		sp := 0
		stack[sp] = i
		sp++
		lab[i] = next
		rep := i
		mx := float32(-1)
		for sp > 0 {
			sp--
			p := stack[sp]
			x, y := p%lw, p/lw
			if d[p] > mx {
				mx = d[p]
				rep = p
			}
			if x > 0 && lab[p-1] == 0 && inside[p-1] && d[p-1]-rec[p-1] > 0.5 {
				lab[p-1] = next
				stack[sp] = p - 1
				sp++
			}
			if x < lw-1 && lab[p+1] == 0 && inside[p+1] && d[p+1]-rec[p+1] > 0.5 {
				lab[p+1] = next
				stack[sp] = p + 1
				sp++
			}
			if y > 0 && lab[p-lw] == 0 && inside[p-lw] && d[p-lw]-rec[p-lw] > 0.5 {
				lab[p-lw] = next
				stack[sp] = p - lw
				sp++
			}
			if y < lh-1 && lab[p+lw] == 0 && inside[p+lw] && d[p+lw]-rec[p+lw] > 0.5 {
				lab[p+lw] = next
				stack[sp] = p + lw
				sp++
			}
		}
		reps = append(reps, rep)
		cMax = append(cMax, mx)
	}
	return reps, cMax
}

// ------------------------------------------------------------- watershed

func Relax(ws []int, saddles *saddleSet, heap *floatHeap, d []float32, lw, lh, p, x, y, lab int, level float32) {
	if x < 0 || y < 0 || x >= lw || y >= lh {
		return
	}
	q := y*lw + x
	if ws[q] < 0 {
		ws[q] = lab
		heap.push(d[q], q)
	} else if ws[q] != lab {
		a, b := ws[q], lab
		if a > b {
			a, b = b, a
		}
		key := int64(b)<<21 | int64(a)
		if old, ok := saddles.get(key); !ok || level > old {
			saddles.set(key, level)
		}
	}
}

func Watershed(d []float32, inside []bool, lw, lh int, reps []int) ([]int, *saddleSet) {
	ws := make([]int, lw*lh)
	for i := 0; i < len(ws); i++ {
		ws[i] = -1
	}
	saddles := newSaddleSet()
	heap := newHeap(1 << 12)
	for k := 0; k < len(reps); k++ {
		ws[reps[k]] = k
		heap.push(d[reps[k]], reps[k])
	}
	for heap.Count() > 0 {
		_, p := heap.pop()
		lab := ws[p]
		x, y := p%lw, p/lw
		Relax(ws, saddles, heap, d, lw, lh, p, x-1, y, lab, d[p])
		Relax(ws, saddles, heap, d, lw, lh, p, x+1, y, lab, d[p])
		Relax(ws, saddles, heap, d, lw, lh, p, x, y-1, lab, d[p])
		Relax(ws, saddles, heap, d, lw, lh, p, x, y+1, lab, d[p])
	}
	return ws, saddles
}

func MergeBasins(uf *UnionFind, saddles *saddleSet, cMax []float32, frac float32) {
	mx := make([]float32, uf.Count())
	for k := 0; k < len(cMax) && k < len(mx); k++ {
		mx[k] = cMax[k]
	}
	for pass := 0; pass < 3; pass++ {
		for i := 0; i < saddles.len(); i++ {
			a := int(saddles.keys[i] & 0x1FFFFF)
			b := int(saddles.keys[i] >> 21)
			ra, rb := uf.Find(a), uf.Find(b)
			if ra == rb {
				continue
			}
			lo := mx[ra]
			if mx[rb] < lo {
				lo = mx[rb]
			}
			if saddles.vals[i] >= frac*lo {
				uf.Union(ra, rb)
				nr := uf.Find(ra)
				hi := mx[ra]
				if mx[rb] > hi {
					hi = mx[rb]
				}
				mx[nr] = hi
			}
		}
	}
}

// ---------------------------------------------------------------- geometry

func RectInside(d []float32, lw, lh int, cx, cy, hw, hh, padPx float64) bool {
	if hw <= 1 || hh <= 1 {
		return false
	}
	x0 := int(math.Ceil(cx - hw))
	x1 := int(math.Floor(cx + hw))
	y0 := int(math.Ceil(cy - hh))
	y1 := int(math.Floor(cy + hh))
	if x0 < 0 || y0 < 0 || x1 >= lw || y1 >= lh {
		return false
	}
	for y := y0; y <= y1; y += 2 {
		for x := x0; x <= x1; x += 2 {
			if float64(d[y*lw+x]) < padPx {
				return false
			}
		}
	}
	if float64(d[y0*lw+x0]) < padPx || float64(d[y0*lw+x1]) < padPx ||
		float64(d[y1*lw+x0]) < padPx || float64(d[y1*lw+x1]) < padPx {
		return false
	}
	ymid := (y0 + y1) / 2
	if float64(d[ymid*lw+x0]) < padPx || float64(d[ymid*lw+x1]) < padPx {
		return false
	}
	xmid := (x0 + x1) / 2
	if float64(d[y0*lw+xmid]) < padPx || float64(d[y1*lw+xmid]) < padPx {
		return false
	}
	return true
}

func BinaryScale(d []float32, lw, lh int, cx, cy, maxHW, maxHH, padPx float64) float64 {
	lo, hi := 0.0, 1.0
	for it := 0; it < 14; it++ {
		mid := (lo + hi) / 2
		if RectInside(d, lw, lh, cx, cy, maxHW*mid, maxHH*mid, padPx) {
			lo = mid
		} else {
			hi = mid
		}
	}
	return lo
}

// Metricise: centroid, safe rectangle, padded outline of one bubble body.
func Metricise(res *Result, lobe []bool, lw, lh, x0, y0 int, padFraction, scale float64) bool {
	dl := Chamfer(lobe, lw, lh)

	bx0, by0, bx1, by1 := lw, lh, -1, -1
	for y := 0; y < lh; y++ {
		for x := 0; x < lw; x++ {
			if !lobe[y*lw+x] {
				continue
			}
			if x < bx0 {
				bx0 = x
			}
			if y < by0 {
				by0 = y
			}
			if x > bx1 {
				bx1 = x
			}
			if y > by1 {
				by1 = y
			}
		}
	}
	if bx1 < 0 {
		return false
	}

	bw := float64(bx1 - bx0 + 1)
	bh := float64(by1 - by0 + 1)
	shortSide := math.Min(bw, bh)
	r14 := math.Max(4.0, 0.14*shortSide)
	padPx := math.Max(2.0, padFraction*shortSide)

	maxL := float32(0)
	maxI := 0
	for i := 0; i < len(dl); i++ {
		if dl[i] > maxL {
			maxL = dl[i]
			maxI = i
		}
	}

	sx, sy, nBody := 0.0, 0.0, int64(0)
	for i := 0; i < len(dl); i++ {
		if float64(dl[i]) >= r14 {
			sx += float64(i % lw)
			sy += float64(i / lw)
			nBody++
		}
	}

	var cx, cy float64
	if nBody > 0 {
		cx = sx / float64(nBody)
		cy = sy / float64(nBody)
	} else {
		cx = float64(maxI % lw)
		cy = float64(maxI / lw)
	}

	icx, icy := int(math.RoundToEven(cx)), int(math.RoundToEven(cy))
	if icx < 0 || icy < 0 || icx >= lw || icy >= lh || float64(dl[icy*lw+icx]) < padPx {
		cx = float64(maxI % lw)
		cy = float64(maxI / lw)
		icx = int(math.RoundToEven(cx))
		icy = int(math.RoundToEven(cy))
	}

	res.center[0] = (float64(x0) + cx) / scale
	res.center[1] = (float64(y0) + cy) / scale
	res.radius = float64(maxL) / scale
	res.bbox[0] = float64(x0+bx0) / scale
	res.bbox[1] = float64(y0+by0) / scale
	res.bbox[2] = float64(x0+bx1+1) / scale
	res.bbox[3] = float64(y0+by1+1) / scale

	maxHW := math.Min(cx, float64(lw-1)-cx)
	maxHH := math.Min(cy, float64(lh-1)-cy)
	seedScale := BinaryScale(dl, lw, lh, cx, cy, maxHW, maxHH, padPx)
	halfW := maxHW * seedScale
	halfH := maxHH * seedScale

	lo, hi, bestW := seedScale, 1.0, seedScale
	for it := 0; it < 14; it++ {
		mid := (lo + hi) / 2
		if RectInside(dl, lw, lh, cx, cy, maxHW*mid, halfH, padPx) {
			bestW = mid
			lo = mid
		} else {
			hi = mid
		}
	}
	halfW = maxHW * bestW
	lo, hi, bestH := seedScale, 1.0, seedScale
	for it := 0; it < 14; it++ {
		mid := (lo + hi) / 2
		if RectInside(dl, lw, lh, cx, cy, halfW, maxHH*mid, padPx) {
			bestH = mid
			lo = mid
		} else {
			hi = mid
		}
	}
	halfH = maxHH * bestH

	res.fitRect[0] = (float64(x0) + cx - halfW) / scale
	res.fitRect[1] = (float64(y0) + cy - halfH) / scale
	res.fitRect[2] = (float64(x0) + cx + halfW) / scale
	res.fitRect[3] = (float64(y0) + cy + halfH) / scale

	const PN = 120
	open := 0
	rayLimit := float64(maxL)*1.8 + 10
	stepRad := 2 * math.Pi / PN
	maxR := math.Sqrt(bw*bw+bh*bh) + 2
	cosT := make([]float64, PN)
	sinT := make([]float64, PN)
	for k := 0; k < PN; k++ {
		ang := float64(k) * stepRad
		cosT[k], sinT[k] = math.Cos(ang), math.Sin(ang)
	}
	res.poly = make([][2]float64, 0, PN)
	for k := 0; k < PN; k++ {
		dx, dy := cosT[k], sinT[k]
		lastR := 0.0
		for rr := 1.0; rr < maxR; rr += 1.0 {
			px := int(math.RoundToEven(cx + dx*rr))
			py := int(math.RoundToEven(cy + dy*rr))
			if px < 0 || py < 0 || px >= lw || py >= lh {
				break
			}
			if float64(dl[py*lw+px]) < padPx {
				break
			}
			lastR = rr
		}
		if lastR > rayLimit {
			open++
		}
		res.poly = append(res.poly, [2]float64{
			(float64(x0) + cx + dx*lastR) / scale,
			(float64(y0) + cy + dy*lastR) / scale,
		})
	}
	res.openRays = open
	for pass := 0; pass < 2; pass++ {
		n := len(res.poly)
		sm := make([][2]float64, n)
		for k := 0; k < n; k++ {
			a := res.poly[(k+n-1)%n]
			b := res.poly[k]
			e := res.poly[(k+1)%n]
			sm[k] = [2]float64{(a[0] + 2*b[0] + e[0]) / 4, (a[1] + 2*b[1] + e[1]) / 4}
		}
		res.poly = sm
	}
	return true
}

func (r *Result) setEmpty() {
	r.bbox = [4]float64{0, 0, 0, 0}
	r.fitRect = [4]float64{0, 0, 0, 0}
	r.center = [2]float64{0, 0}
	r.poly = nil
}

var _ = fmt.Sprintf
